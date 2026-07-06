import express from "express";
import cors from "cors";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";

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
// ─── API DO CRM ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/leads", async (req, res) => {
  try {
    const { status, origem, search } = req.query;
    let query = "SELECT * FROM leads WHERE 1=1";
    const params = [];
    if (status) { params.push(status); query += ` AND status = $${params.length}`; }
    if (origem) { params.push(origem); query += ` AND origem = $${params.length}`; }
    if (search) { params.push(`%${search}%`); query += ` AND (nome ILIKE $${params.length} OR estabelecimento ILIKE $${params.length})`; }
    query += " ORDER BY data DESC";
    const result = await db.query(query, params);
    res.json({ ok: true, leads: result.rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get("/api/leads/:id", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM leads WHERE id = $1", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Lead não encontrado" });
    res.json({ ok: true, lead: result.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/api/leads", async (req, res) => {
  try {
    const { nome, whatsapp, email, estabelecimento, tipo, cidade, status, origem, notas } = req.body;
    if (!nome || !whatsapp || !estabelecimento) return res.status(400).json({ ok: false, error: "nome, whatsapp e estabelecimento são obrigatórios" });
    const result = await db.query(
      `INSERT INTO leads (nome, whatsapp, email, estabelecimento, tipo, cidade, status, origem, notas, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *`,
      [nome, whatsapp, email || null, estabelecimento, tipo || "Food service", cidade || "Montes Claros", status || "novo", origem || "manual", notas || null]
    );
    res.status(201).json({ ok: true, lead: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ ok: false, error: "WhatsApp já cadastrado" });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch("/api/leads/:id", async (req, res) => {
  try {
    const { status, notas, nome, estabelecimento, tipo, cidade, email, origem, proxima_acao, proxima_acao_desc } = req.body;
    try { await db.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS proxima_acao TIMESTAMPTZ'); await db.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS proxima_acao_desc TEXT'); } catch(_) {}
    const result = await db.query(
      `UPDATE leads SET
        status = COALESCE($1,status), notas = COALESCE($2,notas),
        nome = COALESCE($3,nome), estabelecimento = COALESCE($4,estabelecimento),
        tipo = COALESCE($5,tipo), cidade = COALESCE($6,cidade),
        email = COALESCE($7,email), origem = COALESCE($8,origem),
        proxima_acao = $9, proxima_acao_desc = $10,
        atualizado = NOW()
       WHERE id = $11 RETURNING *`,
      [status, notas, nome, estabelecimento, tipo, cidade, email, origem,
       proxima_acao ?? null, proxima_acao_desc ?? null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Lead não encontrado" });
    res.json({ ok: true, lead: result.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete("/api/leads/:id", async (req, res) => {
  try {
    const result = await db.query("DELETE FROM leads WHERE id = $1 RETURNING id", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Lead não encontrado" });
    res.json({ ok: true, deleted: result.rows[0].id });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get("/api/stats", async (req, res) => {
  try {
    const [total, porStatus, porOrigem, semana] = await Promise.all([
      db.query("SELECT COUNT(*) as total FROM leads"),
      db.query("SELECT status, COUNT(*) as count FROM leads GROUP BY status"),
      db.query("SELECT origem, COUNT(*) as count FROM leads GROUP BY origem"),
      db.query("SELECT COUNT(*) as count FROM leads WHERE data >= NOW() - INTERVAL '7 days'"),
    ]);
    res.json({ ok: true, total: parseInt(total.rows[0].total), semana: parseInt(semana.rows[0].count), porStatus: porStatus.rows, porOrigem: porOrigem.rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── UTILITÁRIOS ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", service: "Sofia Fan Fave", timestamp: new Date().toISOString() }));

app.get("/sessions", (_, res) => {
  const list = [];
  for (const [phone, s] of sessions.entries()) {
    list.push({ phone, messages: s.history.length, qualified: s.qualified, followupStatus: s.followupStatus, lastActivity: new Date(s.lastActivity).toISOString() });
  }
  res.json({ total: list.length, sessions: list });
});

app.post("/send", async (req, res) => {
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
