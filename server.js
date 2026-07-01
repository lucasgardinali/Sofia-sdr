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
  ];
  for (const col of cols) {
    try { await db.query(col); } catch (_) {}
  }

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

// ─── PROMPT DA SOFIA ──────────────────────────────────────────────────────────
const SOFIA_SYSTEM = `Você é Sofia, assistente comercial do Fan Fave — plataforma de fidelização digital para negócios de food service (restaurantes, lanchonetes, bares, cafeterias, padarias, food trucks e similares) em Montes Claros e região.

SEU OBJETIVO: qualificar o lead e agendar uma conversa com o time comercial.

SOBRE O FAN FAVE:
- Programa de pontos digital para food service
- O cliente pontua pelo número do celular — sem QR code, sem app complicado
- O dono do estabelecimento acessa um painel com todos os dados dos clientes
- Ativação em até 2 dias com suporte da equipe
- Plano: R$119,90/mês
- Funciona para qualquer negócio de alimentação

SEU FLUXO DE CONVERSA:
1. Saudação calorosa e apresentação rápida
2. Perguntar o nome da pessoa
3. Perguntar qual é o estabelecimento e o segmento
4. Apresentar brevemente o Fan Fave focando na dor (cliente que não volta)
5. Perguntar se faz sentido para o negócio deles
6. Se interesse demonstrado: propor conversa com o time e perguntar melhor horário
7. Se interesse alto ou reunião agendada: marcar como qualificado

REGRAS IMPORTANTES:
- Seja natural, calorosa e direta — como uma atendente humana real
- Mensagens curtas (máximo 3 parágrafos)
- Use emojis com moderação (1-2 por mensagem no máximo)
- Nunca invente funcionalidades que não existem
- Se perguntarem algo que não sabe, diga que vai verificar com o time
- Não force a venda — qualifique primeiro
- Responda sempre em português brasileiro
- Se a pessoa já conversou com você antes, retome o contexto naturalmente

MARCADORES TÉCNICOS OBRIGATÓRIOS (invisíveis para o usuário, removidos automaticamente):

[LQ] — Adicione NO FINAL da resposta quando o lead estiver qualificado:
  - Confirmou que tem negócio de alimentação E demonstrou interesse claro
  - Aceitou conversar com o time comercial
  - Reunião ou conversa foi agendada

[DQ] — Adicione NO FINAL da resposta quando o lead for desqualificado:
  - Disse claramente que não tem interesse
  - Não tem negócio de alimentação
  - Pediu para não ser contatado mais
  - Respondeu de forma muito negativa e definitiva

[RA] — Adicione NO FINAL da resposta quando uma reunião for efetivamente agendada:
  - Data/horário definidos
  - Ou combinado que o time vai ligar em horário específico

NUNCA mencione esses marcadores na conversa. Eles são invisíveis para o usuário.`;

// ─── Z-API ───────────────────────────────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  const res = await fetch(
    `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}/send-text`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Client-Token": process.env.ZAPI_CLIENT_TOKEN },
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

// ─── EXTRAIR INFO ─────────────────────────────────────────────────────────────
function extractInfo(history) {
  const texto = history.filter((m) => m.role === "user").map((m) => m.content).join(" ");
  const nomeMatch = texto.match(/\b([A-ZÁÉÍÓÚÃÕÂÊÎÔÛÇ][a-záéíóúãõâêîôûç]+(?:\s[A-ZÁÉÍÓÚÃÕÂÊÎÔÛÇ][a-záéíóúãõâêîôûç]+)?)\b/);
  return { nome: nomeMatch ? nomeMatch[1] : "Lead WhatsApp" };
}

// ─── SALVAR LEAD ──────────────────────────────────────────────────────────────
async function saveLead(phone, session, status = "novo") {
  const summary = session.history.slice(-8).map((m) => `${m.role === "user" ? "Lead" : "Sofia"}: ${m.content}`).join("\n");
  const { nome } = extractInfo(session.history);
  try {
    await db.query(
      `INSERT INTO leads (nome, whatsapp, estabelecimento, tipo, status, origem, notas, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (whatsapp) DO UPDATE SET
         status     = CASE WHEN leads.status = 'fechado' THEN leads.status ELSE EXCLUDED.status END,
         notas      = EXCLUDED.notas,
         atualizado = NOW()`,
      [nome, phone, session.estabelecimento || "Via WhatsApp", "Food service", status, "whatsapp", summary]
    );
    console.log(`✅ Lead salvo: ${phone} (${nome}) — status: ${status}`);
  } catch (err) {
    console.error("Erro ao salvar lead:", err.message);
  }
}

// ─── NOTIFICAR MANAGER ────────────────────────────────────────────────────────
async function notifyManager(phone, session, tipo = "qualificado") {
  const { nome } = extractInfo(session.history);
  const summary = session.history.slice(-4).map((m) => `${m.role === "user" ? "👤" : "🤖"} ${m.content}`).join("\n");
  const emojis = { qualificado: "🎯", reuniao: "📅", desqualificado: "❌" };
  const labels = { qualificado: "Lead qualificado pela Sofia!", reuniao: "Reunião agendada pela Sofia!", desqualificado: "Lead desqualificado" };
  if (process.env.MANAGER_PHONE) {
    await sendWhatsApp(
      process.env.MANAGER_PHONE,
      `${emojis[tipo]} *${labels[tipo]}*\n\n👤 ${nome}\n📱 ${phone}\n\n💬 Contexto:\n${summary}\n\n_Veja no CRM: fanfave-crm.vercel.app/#crm_`
    );
  }
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

  console.log(`📨 ${phone}: ${text.substring(0, 80)}`);

  const session = await getSession(phone);

  // Se lead já foi desqualificado ou encerrado, não responde
  if (session.followupStatus === "desqualificado") {
    console.log(`⏭️ Lead desqualificado — ignorando: ${phone}`);
    return;
  }

  // Atualiza timestamp e reseta flags de follow-up (lead voltou a responder)
  await updateLastMessage(phone);

  session.history.push({ role: "user", content: text });
  if (session.history.length > 30) session.history = session.history.slice(-30);

  try {
    const systemWithContext = session.followupStatus === "reuniao_agendada"
      ? SOFIA_SYSTEM + "\n\nNOTA: Este lead já tem reunião agendada. Confirme detalhes e seja prestativa. NÃO use [LQ] ou [RA] novamente."
      : SOFIA_SYSTEM;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: systemWithContext,
      messages: session.history,
    });

    const rawReply = response.content[0].text;
    const reply    = removeMarkers(rawReply);
    const markers  = detectMarkers(rawReply);

    // ── Processa marcadores ──
    if (markers.reuniaoAgendada && session.followupStatus !== "reuniao_agendada") {
      session.followupStatus = "reuniao_agendada";
      session.qualified      = true;
      console.log(`📅 Reunião agendada: ${phone}`);
      await saveLead(phone, session, "demo");
      await notifyManager(phone, session, "reuniao");
    } else if (markers.qualificado && !session.qualified) {
      session.qualified      = true;
      session.followupStatus = "qualificado";
      console.log(`🎯 Lead qualificado: ${phone}`);
      await saveLead(phone, session, "contato");
      await notifyManager(phone, session, "qualificado");
    } else if (markers.desqualificado) {
      session.followupStatus = "desqualificado";
      console.log(`❌ Lead desqualificado: ${phone}`);
      await saveLead(phone, session, "novo");
      await notifyManager(phone, session, "desqualificado");
    }

    session.history.push({ role: "assistant", content: reply });
    session.lastActivity = Date.now();

    await saveSession(phone, session);
    await sendWhatsApp(phone, reply);
    console.log(`✅ Sofia respondeu → ${phone} [status: ${session.followupStatus}]`);

  } catch (err) {
    console.error("Erro:", err.message);
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
    const { status, notas, nome, estabelecimento, tipo, cidade, email, origem } = req.body;
    const result = await db.query(
      `UPDATE leads SET
        status = COALESCE($1,status), notas = COALESCE($2,notas),
        nome = COALESCE($3,nome), estabelecimento = COALESCE($4,estabelecimento),
        tipo = COALESCE($5,tipo), cidade = COALESCE($6,cidade),
        email = COALESCE($7,email), origem = COALESCE($8,origem), atualizado = NOW()
       WHERE id = $9 RETURNING *`,
      [status, notas, nome, estabelecimento, tipo, cidade, email, origem, req.params.id]
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
