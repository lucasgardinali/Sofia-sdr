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

// ─── SESSÕES EM MEMÓRIA ──────────────────────────────────────────────────────
const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;

function getSession(phone) {
  const now = Date.now();
  if (!sessions.has(phone)) {
    sessions.set(phone, { history: [], lastActivity: now, qualified: false });
  }
  const session = sessions.get(phone);
  session.lastActivity = now;
  return session;
}

setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TTL) sessions.delete(phone);
  }
}, 10 * 60 * 1000);

// ─── PROMPT DA SOFIA ─────────────────────────────────────────────────────────
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
7. Se interesse alto: marcar como LEAD QUALIFICADO

REGRAS:
- Seja natural, calorosa e direta — como uma atendente humana real
- Mensagens curtas (máximo 3 parágrafos)
- Use emojis com moderação (1-2 por mensagem no máximo)
- Nunca invente funcionalidades que não existem
- Se perguntarem algo que não sabe, diga que vai verificar com o time
- Não force a venda — qualifique primeiro
- Responda sempre em português brasileiro

QUANDO QUALIFICAR O LEAD:
Considere qualificado quando a pessoa:
- Confirmar que tem negócio de alimentação
- Demonstrar interesse em fidelizar clientes
- Aceitar conversar com o time
Quando qualificar, inclua exatamente o texto [LEAD_QUALIFICADO] no final da sua resposta (invisível para o usuário).

EXEMPLO DE ABERTURA:
"Oi! 👋 Aqui é a Sofia, do Fan Fave! Vi que você entrou em contato — tudo bem? Posso te contar rapidinho o que fazemos aqui?"`;

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

// ─── SALVAR LEAD ─────────────────────────────────────────────────────────────
async function saveLead(phone, session) {
  const summary = session.history.slice(-6)
    .map((m) => `${m.role === "user" ? "Lead" : "Sofia"}: ${m.content}`)
    .join("\n");

  const nomeMatch = session.history
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join(" ")
    .match(/\b([A-Z][a-záéíóúãõâêîôûç]+(?:\s[A-Z][a-záéíóúãõâêîôûç]+)?)\b/);

  const nome = nomeMatch ? nomeMatch[1] : "Lead WhatsApp";

  try {
    await db.query(
      `INSERT INTO leads (nome, whatsapp, estabelecimento, tipo, status, origem, notas, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (whatsapp) DO UPDATE SET status = EXCLUDED.status, notas = EXCLUDED.notas`,
      [nome, phone, "Via WhatsApp", "Food service", "novo", "whatsapp", summary]
    );
    console.log(`✅ Lead salvo: ${phone}`);
  } catch (err) {
    console.error("Erro ao salvar lead:", err.message);
  }
}

// ─── NOTIFICAR MANAGER ───────────────────────────────────────────────────────
async function notifyManager(phone, session) {
  const summary = session.history.slice(-4)
    .map((m) => `${m.role === "user" ? "👤" : "🤖"} ${m.content}`)
    .join("\n");
  if (process.env.MANAGER_PHONE) {
    await sendWhatsApp(
      process.env.MANAGER_PHONE,
      `🎯 *Lead qualificado pela Sofia!*\n\n📱 ${phone}\n\n💬 Contexto:\n${summary}\n\n_Veja no CRM._`
    );
  }
}

// ─── WEBHOOK WHATSAPP ────────────────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.fromMe || body.isGroup || body.type !== "ReceivedCallback") return;

  const phone = body.phone?.replace(/\D/g, "");
  const text = body.text?.message || body.audio?.transcription || body.image?.caption || body.document?.caption;
  if (!phone || !text) return;

  console.log(`📨 ${phone}: ${text}`);
  const session = getSession(phone);
  session.history.push({ role: "user", content: text });
  if (session.history.length > 20) session.history = session.history.slice(-20);

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: SOFIA_SYSTEM,
      messages: session.history,
    });

    let reply = response.content[0].text;

    if (reply.includes("[LEAD_QUALIFICADO]") && !session.qualified) {
      session.qualified = true;
      reply = reply.replace("[LEAD_QUALIFICADO]", "").trim();
      await saveLead(phone, session);
      await notifyManager(phone, session);
    }

    session.history.push({ role: "assistant", content: reply });
    await sendWhatsApp(phone, reply);
    console.log(`✅ Sofia respondeu para ${phone}`);
  } catch (err) {
    console.error("Erro:", err.message);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ─── API DO CRM ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

// GET /api/leads — listar todos os leads (com filtros opcionais)
app.get("/api/leads", async (req, res) => {
  try {
    const { status, origem, search } = req.query;
    let query = "SELECT * FROM leads WHERE 1=1";
    const params = [];

    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }
    if (origem) {
      params.push(origem);
      query += ` AND origem = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (nome ILIKE $${params.length} OR estabelecimento ILIKE $${params.length})`;
    }

    query += " ORDER BY data DESC";
    const result = await db.query(query, params);
    res.json({ ok: true, leads: result.rows });
  } catch (err) {
    console.error("GET /api/leads erro:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/leads/:id — buscar lead por ID
app.get("/api/leads/:id", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM leads WHERE id = $1", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Lead não encontrado" });
    res.json({ ok: true, lead: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/leads — criar novo lead
app.post("/api/leads", async (req, res) => {
  try {
    const { nome, whatsapp, email, estabelecimento, tipo, cidade, status, origem, notas } = req.body;
    if (!nome || !whatsapp || !estabelecimento) {
      return res.status(400).json({ ok: false, error: "nome, whatsapp e estabelecimento são obrigatórios" });
    }
    const result = await db.query(
      `INSERT INTO leads (nome, whatsapp, email, estabelecimento, tipo, cidade, status, origem, notas, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *`,
      [nome, whatsapp, email || null, estabelecimento, tipo || "Food service",
       cidade || "Montes Claros", status || "novo", origem || "manual", notas || null]
    );
    res.status(201).json({ ok: true, lead: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ ok: false, error: "WhatsApp já cadastrado" });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/leads/:id — atualizar status e/ou notas
app.patch("/api/leads/:id", async (req, res) => {
  try {
    const { status, notas, nome, estabelecimento, tipo, cidade, email, origem } = req.body;
    const result = await db.query(
      `UPDATE leads SET
        status       = COALESCE($1, status),
        notas        = COALESCE($2, notas),
        nome         = COALESCE($3, nome),
        estabelecimento = COALESCE($4, estabelecimento),
        tipo         = COALESCE($5, tipo),
        cidade       = COALESCE($6, cidade),
        email        = COALESCE($7, email),
        origem       = COALESCE($8, origem),
        atualizado   = NOW()
       WHERE id = $9 RETURNING *`,
      [status, notas, nome, estabelecimento, tipo, cidade, email, origem, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Lead não encontrado" });
    res.json({ ok: true, lead: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/leads/:id — excluir lead
app.delete("/api/leads/:id", async (req, res) => {
  try {
    const result = await db.query("DELETE FROM leads WHERE id = $1 RETURNING id", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Lead não encontrado" });
    res.json({ ok: true, deleted: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/stats — estatísticas para o dashboard do CRM
app.get("/api/stats", async (req, res) => {
  try {
    const [total, porStatus, porOrigem, semana] = await Promise.all([
      db.query("SELECT COUNT(*) as total FROM leads"),
      db.query("SELECT status, COUNT(*) as count FROM leads GROUP BY status"),
      db.query("SELECT origem, COUNT(*) as count FROM leads GROUP BY origem"),
      db.query("SELECT COUNT(*) as count FROM leads WHERE data >= NOW() - INTERVAL '7 days'"),
    ]);

    res.json({
      ok: true,
      total: parseInt(total.rows[0].total),
      semana: parseInt(semana.rows[0].count),
      porStatus: porStatus.rows,
      porOrigem: porOrigem.rows,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── UTILITÁRIOS ─────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Sofia Fan Fave", timestamp: new Date().toISOString() });
});

app.get("/sessions", (req, res) => {
  const list = [];
  for (const [phone, session] of sessions.entries()) {
    list.push({ phone, messages: session.history.length, qualified: session.qualified, lastActivity: new Date(session.lastActivity).toISOString() });
  }
  res.json({ total: list.length, sessions: list });
});

app.post("/send", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone e message são obrigatórios" });
  try {
    const result = await sendWhatsApp(phone, message);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 Sofia online na porta ${PORT}`);
  console.log(`📡 API CRM disponível em /api/leads`);
});
