import express from "express";
import cors from "cors";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const app = express();
app.use(cors());
app.use(express.json());

// ─── CLIENTES ────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── SESSÕES EM MEMÓRIA ───────────────────────────────────────────────────────
const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TTL) sessions.delete(phone);
  }
}, 10 * 60 * 1000);

// ─── SETUP DO BANCO ───────────────────────────────────────────────────────────
async function setupDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sofia_sessions (
      phone              TEXT PRIMARY KEY,
      history            JSONB    DEFAULT '[]',
      qualified          BOOLEAN  DEFAULT false,
      nome               TEXT,
      estabelecimento    TEXT,
      followup_status    TEXT     DEFAULT 'ativo',
      last_message_at    TIMESTAMPTZ DEFAULT NOW(),
      followup_1h        BOOLEAN  DEFAULT false,
      followup_24h       BOOLEAN  DEFAULT false,
      followup_7d        BOOLEAN  DEFAULT false,
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Garante colunas caso tabela já exista de versão anterior
  const cols = [
    `ALTER TABLE sofia_sessions ADD COLUMN IF NOT EXISTS followup_status TEXT DEFAULT 'ativo'`,
    `ALTER TABLE sofia_sessions ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE sofia_sessions ADD COLUMN IF NOT EXISTS followup_1h BOOLEAN DEFAULT false`,
    `ALTER TABLE sofia_sessions ADD COLUMN IF NOT EXISTS followup_24h BOOLEAN DEFAULT false`,
    `ALTER TABLE sofia_sessions ADD COLUMN IF NOT EXISTS followup_7d BOOLEAN DEFAULT false`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS proxima_acao TIMESTAMPTZ`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS proxima_acao_desc TEXT`,
  ];
  for (const col of cols) {
    try { await db.query(col); } catch (_) {}
  }

  // Remove o CHECK constraint antigo do status e recria com 'arquivado' incluído
  try {
    await db.query(`ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check`);
    await db.query(`ALTER TABLE leads ADD CONSTRAINT leads_status_check CHECK (status IN ('novo','contato','demo','negociacao','fechado','arquivado'))`);
  } catch (_) {}

  // Remove o CHECK constraint antigo da origem e recria com 'diagnostico' incluído
  try {
    await db.query(`ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_origem_check`);
    await db.query(`ALTER TABLE leads ADD CONSTRAINT leads_origem_check CHECK (origem IN ('instagram','landing','whatsapp','indicacao','manual','diagnostico'))`);
  } catch (_) {}

  console.log("✅ Banco configurado");
}

// ─── AUTENTICAÇÃO ─────────────────────────────────────────────────────────────

// Middleware completo: verifica JWT, ativo, precisa_trocar_senha e role.
function auth(...roles) {
  return async (req, res, next) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ ok: false, error: "Token não fornecido" });
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET); }
    catch { return res.status(401).json({ ok: false, error: "Token inválido ou expirado" }); }
    try {
      const r = await db.query(
        "SELECT id, tenant_id, role, ativo, precisa_trocar_senha FROM users WHERE id = $1",
        [payload.sub]
      );
      if (!r.rows.length || !r.rows[0].ativo)
        return res.status(401).json({ ok: false, error: "Usuário inativo ou não encontrado" });
      const u = r.rows[0];
      if (u.precisa_trocar_senha)
        return res.status(403).json({ ok: false, error: "troca_senha_obrigatoria" });
      if (roles.length && !roles.includes(u.role))
        return res.status(403).json({ ok: false, error: "Sem permissão" });
      req.user = { id: u.id, tenantId: u.tenant_id, role: u.role };
      next();
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  };
}

// Middleware leve: só verifica JWT e ativo. Usado em /auth/trocar-senha,
// que deve ser acessível mesmo com precisa_trocar_senha = true.
function authLight() {
  return async (req, res, next) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ ok: false, error: "Token não fornecido" });
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET); }
    catch { return res.status(401).json({ ok: false, error: "Token inválido ou expirado" }); }
    try {
      const r = await db.query(
        "SELECT id, tenant_id, role, ativo FROM users WHERE id = $1",
        [payload.sub]
      );
      if (!r.rows.length || !r.rows[0].ativo)
        return res.status(401).json({ ok: false, error: "Usuário inativo ou não encontrado" });
      const u = r.rows[0];
      req.user = { id: u.id, tenantId: u.tenant_id, role: u.role };
      next();
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  };
}

// Retorna o tenantId correto para a query: para super_admin, exige ?tenant_id= na querystring.
function resolveTenantId(req) {
  if (req.user.role === "super_admin") {
    const tid = req.query.tenant_id || req.body?.tenant_id;
    if (!tid) throw new Error("tenant_id obrigatório para super_admin");
    return tid;
  }
  return req.user.tenantId;
}

// ─── SESSÃO ───────────────────────────────────────────────────────────────────
async function loadSession(phone) {
  try {
    const result = await db.query("SELECT * FROM sofia_sessions WHERE phone = $1", [phone]);
    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        history:         row.history || [],
        qualified:       row.qualified || false,
        nome:            row.nome || null,
        estabelecimento: row.estabelecimento || null,
        followupStatus:  row.followup_status || "ativo",
        lastActivity:    Date.now(),
        fromDb:          true,
      };
    }
  } catch (err) {
    console.error("Erro ao carregar sessão:", err.message);
  }
  return { history: [], qualified: false, nome: null, estabelecimento: null, followupStatus: "ativo", lastActivity: Date.now(), fromDb: false };
}

async function saveSession(phone, session) {
  try {
    await db.query(
      `INSERT INTO sofia_sessions (phone, history, qualified, nome, estabelecimento, followup_status, last_message_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
       ON CONFLICT (phone) DO UPDATE SET
         history          = $2,
         qualified        = $3,
         nome             = $4,
         estabelecimento  = $5,
         followup_status  = $6,
         updated_at       = NOW()`,
      [phone, JSON.stringify(session.history), session.qualified,
       session.nome || null, session.estabelecimento || null,
       session.followupStatus || "ativo"]
    );
  } catch (err) {
    console.error("Erro ao salvar sessão:", err.message);
  }
}

async function getSession(phone) {
  if (sessions.has(phone)) {
    const s = sessions.get(phone);
    s.lastActivity = Date.now();
    return s;
  }
  const s = await loadSession(phone);
  sessions.set(phone, s);
  return s;
}

async function updateLastMessage(phone) {
  try {
    await db.query(
      `UPDATE sofia_sessions
       SET last_message_at = NOW(),
           followup_1h  = false,
           followup_24h = false,
           followup_7d  = false
       WHERE phone = $1`,
      [phone]
    );
  } catch (err) {
    console.error("Erro ao atualizar last_message_at:", err.message);
  }
}

// ─── MULTI-TENANT: RESOLUÇÃO E CONTEXTO ──────────────────────────────────────

async function resolveInstance(instanceId) {
  try {
    const result = await db.query(
      `SELECT tenant_id, token, client_token FROM whatsapp_instances WHERE instance_id = $1`,
      [instanceId]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return { tenantId: row.tenant_id, token: row.token, clientToken: row.client_token };
  } catch (err) {
    console.error("Erro ao resolver instância:", err.message);
    return null;
  }
}

async function loadAgentConfig(tenantId) {
  const result = await db.query(
    `SELECT persona_prompt, manager_phone, nome_agente FROM agent_config WHERE tenant_id = $1 AND ativo = true`,
    [tenantId]
  );
  if (!result.rows.length) throw new Error(`agent_config não encontrado para tenant ${tenantId}`);
  return result.rows[0];
}

async function loadOrCreateContact(tenantId, phone) {
  const result = await db.query(
    `INSERT INTO contacts (tenant_id, nome, telefone)
     VALUES ($1, 'Contato WhatsApp', $2)
     ON CONFLICT (tenant_id, telefone) DO UPDATE SET atualizado_em = NOW()
     RETURNING id, etapa_funil, nome`,
    [tenantId, phone]
  );
  return result.rows[0];
}

async function loadOrCreateConversation(tenantId, contactId) {
  const existing = await db.query(
    `SELECT id FROM conversations
     WHERE tenant_id = $1 AND contact_id = $2 AND status = 'aberta' LIMIT 1`,
    [tenantId, contactId]
  );
  if (existing.rows.length) return existing.rows[0];
  const created = await db.query(
    `INSERT INTO conversations (tenant_id, contact_id) VALUES ($1, $2) RETURNING id`,
    [tenantId, contactId]
  );
  return created.rows[0];
}

async function loadRecentMessages(conversationId, limit = 30) {
  const result = await db.query(
    `SELECT remetente, conteudo FROM messages
     WHERE conversation_id = $1
     ORDER BY criado_em ASC`,
    [conversationId]
  );
  return result.rows.slice(-limit).map(row => ({
    role:    row.remetente === "contato" ? "user" : "assistant",
    content: row.conteudo,
  }));
}

async function saveMessage(tenantId, conversationId, remetente, conteudo) {
  await db.query(
    `INSERT INTO messages (tenant_id, conversation_id, remetente, conteudo) VALUES ($1,$2,$3,$4)`,
    [tenantId, conversationId, remetente, conteudo]
  );
  await db.query(
    `UPDATE conversations SET ultima_mensagem_em = NOW() WHERE id = $1`,
    [conversationId]
  );
}

async function updateContactEtapaFunil(contactId, etapa, nome = null) {
  await db.query(
    `UPDATE contacts SET etapa_funil = $2, nome = COALESCE($3, nome), atualizado_em = NOW() WHERE id = $1`,
    [contactId, etapa, nome]
  );
}

async function archiveConversation(conversationId) {
  await db.query(
    `UPDATE conversations SET status = 'arquivada' WHERE id = $1`,
    [conversationId]
  );
}

// SOFIA_SYSTEM removido — prompt mora em agent_config.persona_prompt no banco.

// ─── Z-API ───────────────────────────────────────────────────────────────────
// creds = { instanceId, token, clientToken } — se omitido, usa env vars (follow-up job)
async function sendWhatsApp(phone, message, creds = {}) {
  const instanceId  = creds.instanceId  || process.env.ZAPI_INSTANCE_ID;
  const token       = creds.token       || process.env.ZAPI_TOKEN;
  const clientToken = creds.clientToken || process.env.ZAPI_CLIENT_TOKEN;
  const res = await fetch(
    `https://api.z-api.io/instances/${instanceId}/token/${token}/send-text`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Client-Token": clientToken },
      body: JSON.stringify({ phone, message }),
    }
  );
  const data = await res.json();
  if (!res.ok) console.error("Z-API erro:", data);
  return data;
}

// ─── MARCADORES ───────────────────────────────────────────────────────────────
function removeMarkers(text) {
  return text.replace(/\[LQ\]/gi, "").replace(/\[DQ\]/gi, "").replace(/\[RA\]/gi, "")
    .replace(/\[LEAD_QUALIFICADO\]/gi, "").replace(/\[DESQUALIFICADO\]/gi, "").replace(/\[REUNIAO_AGENDADA\]/gi, "")
    .trim();
}

function detectMarkers(text) {
  return {
    qualificado:     /\[LQ\]/i.test(text) || /\[LEAD_QUALIFICADO\]/i.test(text),
    desqualificado:  /\[DQ\]/i.test(text) || /\[DESQUALIFICADO\]/i.test(text),
    reuniaoAgendada: /\[RA\]/i.test(text) || /\[REUNIAO_AGENDADA\]/i.test(text),
  };
}

// extractInfo e saveLead removidos — substituídos por updateContactEtapaFunil.

// ─── NOTIFICAR MANAGER ────────────────────────────────────────────────────────
async function notifyManager(phone, contactNome, recentMessages, tipo, managerPhone, creds) {
  if (!managerPhone) return;
  const summary = recentMessages.slice(-4).map((m) => `${m.role === "user" ? "👤" : "🤖"} ${m.content}`).join("\n");
  const emojis = { qualificado: "🎯", reuniao: "📅", desqualificado: "❌" };
  const labels = { qualificado: "Lead qualificado!", reuniao: "Reunião agendada!", desqualificado: "Lead desqualificado" };
  await sendWhatsApp(
    managerPhone,
    `${emojis[tipo]} *${labels[tipo]}*\n\n👤 ${contactNome}\n📱 ${phone}\n\n💬 Contexto:\n${summary}\n\n_Veja no CRM: fanfave-crm.vercel.app/#crm_`,
    creds
  );
}

// ─── FOLLOW-UP ────────────────────────────────────────────────────────────────
async function generateFollowUp(phone, session, tipo) {
  const contexto = session.history.slice(-6).map((m) => `${m.role === "user" ? "Lead" : "Sofia"}: ${m.content}`).join("\n");

  const prompts = {
    "1h":  `Você é Sofia do Fan Fave. O lead parou de responder há 1 hora. Com base na conversa abaixo, escreva UMA mensagem curta e calorosa verificando se a pessoa ainda está por aí. Seja leve, não pressione. Máximo 2 linhas. NÃO use marcadores técnicos.\n\nConversa:\n${contexto}`,
    "24h": `Você é Sofia do Fan Fave. O lead parou de responder há mais de 24 horas. Com base na conversa abaixo, escreva UMA mensagem para retomar o contato. Relembre brevemente o valor do Fan Fave e convide para continuar. Tom amigável, sem pressão. Máximo 3 linhas. NÃO use marcadores técnicos.\n\nConversa:\n${contexto}`,
    "7d":  `Você é Sofia do Fan Fave. O lead parou de responder há 7 dias. Com base na conversa abaixo, escreva UMA mensagem direta e objetiva de última tentativa. Mencione que ainda tem interesse em ajudar e deixe uma abertura clara. Máximo 3 linhas. NÃO use marcadores técnicos.\n\nConversa:\n${contexto}`,
  };

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      messages: [{ role: "user", content: prompts[tipo] }],
    });
    return removeMarkers(response.content[0].text);
  } catch (err) {
    console.error("Erro ao gerar follow-up:", err.message);
    return null;
  }
}

// Job roda a cada 15 minutos
async function runFollowUpJob() {
  console.log("⏰ Rodando job de follow-up...");
  try {
    const result = await db.query(`
      SELECT phone, history, nome, followup_1h, followup_24h, followup_7d, last_message_at, followup_status
      FROM sofia_sessions
      WHERE followup_status = 'ativo'
        AND jsonb_array_length(history) > 0
        AND last_message_at IS NOT NULL
        AND last_message_at < NOW() - INTERVAL '55 minutes'
    `);

    const now = new Date();

    for (const row of result.rows) {
      const phone = row.phone;
      const session = { history: row.history || [], nome: row.nome, qualified: false };
      const lastMsg = new Date(row.last_message_at);
      const diffMs = now - lastMsg;
      const diffHours = diffMs / (1000 * 60 * 60);
      const diffDays = diffHours / 24;

      // 1 hora
      if (diffHours >= 1 && diffHours < 24 && !row.followup_1h) {
        console.log(`📩 Follow-up 1h → ${phone}`);
        const msg = await generateFollowUp(phone, session, "1h");
        if (msg) {
          await sendWhatsApp(phone, msg);
          await db.query(`UPDATE sofia_sessions SET followup_1h = true WHERE phone = $1`, [phone]);
          const s = await getSession(phone);
          s.history.push({ role: "assistant", content: msg });
          await saveSession(phone, s);
        }
      }

      // 24 horas
      if (diffDays >= 1 && diffDays < 7 && !row.followup_24h) {
        console.log(`📩 Follow-up 24h → ${phone}`);
        const msg = await generateFollowUp(phone, session, "24h");
        if (msg) {
          await sendWhatsApp(phone, msg);
          await db.query(`UPDATE sofia_sessions SET followup_24h = true WHERE phone = $1`, [phone]);
          const s = await getSession(phone);
          s.history.push({ role: "assistant", content: msg });
          await saveSession(phone, s);
        }
      }

      // 7 dias
      if (diffDays >= 7 && !row.followup_7d) {
        console.log(`📩 Follow-up 7d → ${phone}`);
        const msg = await generateFollowUp(phone, session, "7d");
        if (msg) {
          await sendWhatsApp(phone, msg);
          await db.query(`UPDATE sofia_sessions SET followup_7d = true, followup_status = 'encerrado' WHERE phone = $1`, [phone]);
          const s = await getSession(phone);
          s.history.push({ role: "assistant", content: msg });
          s.followupStatus = "encerrado";
          await saveSession(phone, s);
        }
      }
    }

    console.log(`✅ Job concluído — ${result.rows.length} sessões verificadas`);
  } catch (err) {
    console.error("Erro no job de follow-up:", err.message);
  }
}

setInterval(runFollowUpJob, 15 * 60 * 1000);

// ─── WEBHOOK PRINCIPAL ────────────────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (body.fromMe || body.isGroup || body.type !== "ReceivedCallback") return;

  const phone = body.phone?.replace(/\D/g, "");
  const text  = body.text?.message || body.audio?.transcription || body.image?.caption || body.document?.caption;
  if (!phone || !text) return;

  // Resolve tenant a partir da instância Z-API que recebeu a mensagem
  const instance = await resolveInstance(body.instanceId);
  if (!instance) {
    console.warn(`⚠️ Instância desconhecida: ${body.instanceId}`);
    return;
  }
  const { tenantId, token, clientToken } = instance;
  const creds = { instanceId: body.instanceId, token, clientToken };

  console.log(`📨 [${tenantId}] ${phone}: ${text.substring(0, 80)}`);

  try {
    const [agentConfig, contact] = await Promise.all([
      loadAgentConfig(tenantId),
      loadOrCreateContact(tenantId, phone),
    ]);

    if (contact.etapa_funil === "desqualificado") {
      console.log(`⏭️ Lead desqualificado — ignorando: ${phone}`);
      return;
    }

    const conversation = await loadOrCreateConversation(tenantId, contact.id);

    await saveMessage(tenantId, conversation.id, "contato", text);

    const history = await loadRecentMessages(conversation.id);

    const systemWithContext = contact.etapa_funil === "demo"
      ? agentConfig.persona_prompt + "\n\nNOTA: Este lead já tem reunião agendada. Confirme detalhes e seja prestativa. NÃO use [LQ] ou [RA] novamente."
      : agentConfig.persona_prompt;

    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 500,
      system:     systemWithContext,
      messages:   history,
    });

    const rawReply = response.content[0].text;
    const reply    = removeMarkers(rawReply);
    const markers  = detectMarkers(rawReply);

    // ── Processa marcadores ──
    if (markers.reuniaoAgendada && contact.etapa_funil !== "demo") {
      console.log(`📅 Reunião agendada: ${phone}`);
      await updateContactEtapaFunil(contact.id, "demo");
      await notifyManager(phone, contact.nome, history, "reuniao", agentConfig.manager_phone, creds);
    } else if (markers.qualificado && contact.etapa_funil === "novo_lead") {
      console.log(`🎯 Lead qualificado: ${phone}`);
      await updateContactEtapaFunil(contact.id, "em_contato");
      await notifyManager(phone, contact.nome, history, "qualificado", agentConfig.manager_phone, creds);
    } else if (markers.desqualificado) {
      console.log(`❌ Lead desqualificado: ${phone}`);
      await updateContactEtapaFunil(contact.id, "desqualificado");
      await archiveConversation(conversation.id);
      await notifyManager(phone, contact.nome, history, "desqualificado", agentConfig.manager_phone, creds);
    }

    await saveMessage(tenantId, conversation.id, "agente_ia", reply);
    await sendWhatsApp(phone, reply, creds);
    console.log(`✅ ${agentConfig.nome_agente} respondeu → ${phone} [etapa: ${contact.etapa_funil}]`);

  } catch (err) {
    console.error("Erro no webhook:", err.message);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ─── AUTH ───────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

app.post("/auth/login", async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha)
      return res.status(400).json({ ok: false, error: "email e senha são obrigatórios" });
    const r = await db.query(
      "SELECT id, tenant_id, role, senha_hash, ativo, precisa_trocar_senha FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    );
    const u = r.rows[0];
    if (!u || !u.ativo || !(await bcrypt.compare(senha, u.senha_hash)))
      return res.status(401).json({ ok: false, error: "Credenciais inválidas" });
    const token = jwt.sign({ sub: u.id, role: u.role }, process.env.JWT_SECRET, { expiresIn: "8h" });
    res.json({ ok: true, token, precisa_trocar_senha: u.precisa_trocar_senha });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Único endpoint acessível com precisa_trocar_senha = true (usa authLight).
app.post("/auth/trocar-senha", authLight(), async (req, res) => {
  try {
    const { senha_atual, senha_nova } = req.body;
    if (!senha_atual || !senha_nova)
      return res.status(400).json({ ok: false, error: "senha_atual e senha_nova são obrigatórios" });
    if (senha_nova.length < 8)
      return res.status(400).json({ ok: false, error: "senha_nova deve ter ao menos 8 caracteres" });
    const r = await db.query("SELECT senha_hash FROM users WHERE id = $1", [req.user.id]);
    if (!(await bcrypt.compare(senha_atual, r.rows[0].senha_hash)))
      return res.status(401).json({ ok: false, error: "Senha atual incorreta" });
    const hash = await bcrypt.hash(senha_nova, 12);
    await db.query(
      "UPDATE users SET senha_hash = $1, precisa_trocar_senha = false WHERE id = $2",
      [hash, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/auth/criar-usuario", auth("super_admin", "tenant_admin"), async (req, res) => {
  try {
    const { nome, email, senha_provisoria, role, tenant_id } = req.body;
    if (!nome || !email || !senha_provisoria || !role)
      return res.status(400).json({ ok: false, error: "nome, email, senha_provisoria e role são obrigatórios" });
    if (req.user.role === "tenant_admin") {
      if (role !== "atendente")
        return res.status(403).json({ ok: false, error: "tenant_admin só pode criar atendentes" });
      if (tenant_id && tenant_id !== req.user.tenantId)
        return res.status(403).json({ ok: false, error: "Sem permissão para esse tenant" });
    }
    const targetTenantId = req.user.role === "super_admin" ? (tenant_id || null) : req.user.tenantId;
    const hash = await bcrypt.hash(senha_provisoria, 12);
    const r = await db.query(
      `INSERT INTO users (tenant_id, nome, email, senha_hash, role, precisa_trocar_senha)
       VALUES ($1,$2,$3,$4,$5,true) RETURNING id, nome, email, role, criado_em`,
      [targetTenantId, nome, email.toLowerCase().trim(), hash, role]
    );
    res.status(201).json({ ok: true, user: r.rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ ok: false, error: "E-mail já cadastrado" });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ─── API DO CRM ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/contacts", auth("super_admin", "tenant_admin", "atendente"), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const { etapa_funil, search } = req.query;
    let query = "SELECT * FROM contacts WHERE tenant_id = $1";
    const params = [tenantId];
    if (etapa_funil) { params.push(etapa_funil); query += ` AND etapa_funil = $${params.length}`; }
    if (search) { params.push(`%${search}%`); query += ` AND (nome ILIKE $${params.length} OR telefone ILIKE $${params.length})`; }
    query += " ORDER BY atualizado_em DESC";
    const result = await db.query(query, params);
    res.json({ ok: true, contacts: result.rows });
  } catch (err) {
    if (err.message.includes("tenant_id obrigatório")) return res.status(400).json({ ok: false, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/contacts/:id", auth("super_admin", "tenant_admin", "atendente"), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const result = await db.query(
      "SELECT * FROM contacts WHERE id = $1 AND tenant_id = $2",
      [req.params.id, tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Contato não encontrado" });
    res.json({ ok: true, contact: result.rows[0] });
  } catch (err) {
    if (err.message.includes("tenant_id obrigatório")) return res.status(400).json({ ok: false, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/contacts", auth("super_admin", "tenant_admin"), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const { nome, telefone, email, etapa_funil, campos_customizados } = req.body;
    if (!nome || !telefone)
      return res.status(400).json({ ok: false, error: "nome e telefone são obrigatórios" });
    const result = await db.query(
      `INSERT INTO contacts (tenant_id, nome, telefone, email, etapa_funil, campos_customizados)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantId, nome, telefone, email || null, etapa_funil || "novo_lead", campos_customizados || {}]
    );
    res.status(201).json({ ok: true, contact: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ ok: false, error: "Telefone já cadastrado neste tenant" });
    if (err.message.includes("tenant_id obrigatório")) return res.status(400).json({ ok: false, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch("/api/contacts/:id", auth("super_admin", "tenant_admin", "atendente"), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const { nome, telefone, email, etapa_funil, campos_customizados, atendente_id } = req.body;
    const result = await db.query(
      `UPDATE contacts SET
        nome              = COALESCE($1, nome),
        telefone          = COALESCE($2, telefone),
        email             = COALESCE($3, email),
        etapa_funil       = COALESCE($4, etapa_funil),
        campos_customizados = COALESCE($5, campos_customizados),
        atendente_id      = COALESCE($6, atendente_id),
        atualizado_em     = NOW()
       WHERE id = $7 AND tenant_id = $8 RETURNING *`,
      [nome, telefone, email, etapa_funil, campos_customizados, atendente_id, req.params.id, tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Contato não encontrado" });
    res.json({ ok: true, contact: result.rows[0] });
  } catch (err) {
    if (err.message.includes("tenant_id obrigatório")) return res.status(400).json({ ok: false, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/contacts/:id", auth("super_admin", "tenant_admin"), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const result = await db.query(
      "DELETE FROM contacts WHERE id = $1 AND tenant_id = $2 RETURNING id",
      [req.params.id, tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Contato não encontrado" });
    res.json({ ok: true, deleted: result.rows[0].id });
  } catch (err) {
    if (err.message.includes("tenant_id obrigatório")) return res.status(400).json({ ok: false, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/stats", auth("super_admin", "tenant_admin"), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const [total, porEtapa, semana] = await Promise.all([
      db.query("SELECT COUNT(*) as total FROM contacts WHERE tenant_id = $1", [tenantId]),
      db.query("SELECT etapa_funil, COUNT(*) as count FROM contacts WHERE tenant_id = $1 GROUP BY etapa_funil", [tenantId]),
      db.query("SELECT COUNT(*) as count FROM contacts WHERE tenant_id = $1 AND criado_em >= NOW() - INTERVAL '7 days'", [tenantId]),
    ]);
    res.json({ ok: true, total: parseInt(total.rows[0].total), semana: parseInt(semana.rows[0].count), porEtapa: porEtapa.rows });
  } catch (err) {
    if (err.message.includes("tenant_id obrigatório")) return res.status(400).json({ ok: false, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── UTILITÁRIOS ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", service: "Sofia Fan Fave", timestamp: new Date().toISOString() }));

app.get("/sessions", auth("super_admin"), (req, res) => {
  const list = [];
  for (const [phone, s] of sessions.entries()) {
    list.push({ phone, messages: s.history.length, qualified: s.qualified, followupStatus: s.followupStatus, lastActivity: new Date(s.lastActivity).toISOString() });
  }
  res.json({ total: list.length, sessions: list });
});

app.post("/send", auth("super_admin"), async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone e message são obrigatórios" });
  try { res.json({ ok: true, result: await sendWhatsApp(phone, message) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await setupDb();
  console.log(`🤖 Sofia online na porta ${PORT}`);
  console.log(`📡 Webhook: /webhook/whatsapp`);
  console.log(`📊 API CRM: /api/leads`);
  console.log(`⏰ Follow-up job: a cada 15 minutos`);
});
