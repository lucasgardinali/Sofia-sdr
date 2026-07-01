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

// ─── SESSÕES EM MEMÓRIA (cache rápido) ───────────────────────────────────────
const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TTL) sessions.delete(phone);
  }
}, 10 * 60 * 1000);

// ─── MEMÓRIA PERSISTENTE NO BANCO ────────────────────────────────────────────
async function loadSession(phone) {
  try {
    // Cria tabela de sessões se não existir
    await db.query(`
      CREATE TABLE IF NOT EXISTS sofia_sessions (
        phone TEXT PRIMARY KEY,
        history JSONB DEFAULT '[]',
        qualified BOOLEAN DEFAULT false,
        nome TEXT,
        estabelecimento TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const result = await db.query(
      "SELECT * FROM sofia_sessions WHERE phone = $1",
      [phone]
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        history: row.history || [],
        qualified: row.qualified || false,
        nome: row.nome || null,
        estabelecimento: row.estabelecimento || null,
        lastActivity: Date.now(),
        fromDb: true,
      };
    }
  } catch (err) {
    console.error("Erro ao carregar sessão:", err.message);
  }

  return { history: [], qualified: false, nome: null, estabelecimento: null, lastActivity: Date.now(), fromDb: false };
}

async function saveSession(phone, session) {
  try {
    await db.query(
      `INSERT INTO sofia_sessions (phone, history, qualified, nome, estabelecimento, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (phone) DO UPDATE SET
         history = $2,
         qualified = $3,
         nome = $4,
         estabelecimento = $5,
         updated_at = NOW()`,
      [
        phone,
        JSON.stringify(session.history),
        session.qualified,
        session.nome || null,
        session.estabelecimento || null,
      ]
    );
  } catch (err) {
    console.error("Erro ao salvar sessão:", err.message);
  }
}

async function getSession(phone) {
  // Verifica cache em memória primeiro
  if (sessions.has(phone)) {
    const session = sessions.get(phone);
    session.lastActivity = Date.now();
    return session;
  }

  // Busca no banco se não estiver em memória
  const session = await loadSession(phone);
  sessions.set(phone, session);
  return session;
}

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
7. Se interesse alto: marcar como lead qualificado

REGRAS IMPORTANTES:
- Seja natural, calorosa e direta — como uma atendente humana real
- Mensagens curtas (máximo 3 parágrafos)
- Use emojis com moderação (1-2 por mensagem no máximo)
- Nunca invente funcionalidades que não existem
- Se perguntarem algo que não sabe, diga que vai verificar com o time
- Não force a venda — qualifique primeiro
- Responda sempre em português brasileiro
- Se a pessoa já conversou com você antes, retome o contexto naturalmente sem precisar se reapresentar

QUANDO QUALIFICAR O LEAD:
Considere qualificado quando a pessoa:
- Confirmar que tem negócio de alimentação
- Demonstrar interesse em fidelizar clientes
- Aceitar conversar com o time

INSTRUÇÃO TÉCNICA OBRIGATÓRIA:
Quando o lead estiver qualificado, adicione APENAS ao final da sua resposta, sem espaço antes, o marcador: [LQ]
Este marcador é INVISÍVEL para o usuário e será removido automaticamente. NUNCA mencione este marcador na conversa.`;

// ─── Z-API ───────────────────────────────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  const res = await fetch(
    `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}/send-text`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Client-Token": process.env.ZAPI_CLIENT_TOKEN,
      },
      body: JSON.stringify({ phone, message }),
    }
  );
  const data = await res.json();
  if (!res.ok) console.error("Z-API erro:", data);
  return data;
}

// ─── EXTRAIR NOME E ESTABELECIMENTO DO HISTÓRICO ─────────────────────────────
function extractInfo(history) {
  const texto = history
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join(" ");

  const nomeMatch = texto.match(/\b([A-ZÁÉÍÓÚÃÕÂÊÎÔÛÇ][a-záéíóúãõâêîôûç]+(?:\s[A-ZÁÉÍÓÚÃÕÂÊÎÔÛÇ][a-záéíóúãõâêîôûç]+)?)\b/);
  const nome = nomeMatch ? nomeMatch[1] : "Lead WhatsApp";

  return { nome };
}

// ─── SALVAR LEAD ─────────────────────────────────────────────────────────────
async function saveLead(phone, session) {
  const summary = session.history
    .slice(-8)
    .map((m) => `${m.role === "user" ? "Lead" : "Sofia"}: ${m.content}`)
    .join("\n");

  const { nome } = extractInfo(session.history);

  try {
    await db.query(
      `INSERT INTO leads (nome, whatsapp, estabelecimento, tipo, status, origem, notas, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (whatsapp) DO UPDATE SET
         status = CASE WHEN leads.status = 'fechado' THEN leads.status ELSE 'contato' END,
         notas = EXCLUDED.notas,
         atualizado = NOW()`,
      [nome, phone, session.estabelecimento || "Via WhatsApp", "Food service", "novo", "whatsapp", summary]
    );
    console.log(`✅ Lead salvo: ${phone} (${nome})`);
  } catch (err) {
    console.error("Erro ao salvar lead:", err.message);
  }
}

// ─── NOTIFICAR MANAGER ───────────────────────────────────────────────────────
async function notifyManager(phone, session) {
  const { nome } = extractInfo(session.history);
  const summary = session.history
    .slice(-4)
    .map((m) => `${m.role === "user" ? "👤" : "🤖"} ${m.content}`)
    .join("\n");

  if (process.env.MANAGER_PHONE) {
    const msg = `🎯 *Lead qualificado pela Sofia!*\n\n👤 ${nome}\n📱 ${phone}\n\n💬 Contexto:\n${summary}\n\n_Veja no CRM: fanfave-crm.vercel.app/#crm_`;
    await sendWhatsApp(process.env.MANAGER_PHONE, msg);
  }
}

// ─── REMOVER MARCADOR DO TEXTO ────────────────────────────────────────────────
function removeMarker(text) {
  // Remove qualquer variação do marcador com regex
  return text
    .replace(/\[LQ\]/gi, "")
    .replace(/\[LEAD_QUALIFICADO\]/gi, "")
    .replace(/\[lead qualificado\]/gi, "")
    .trim();
}

function hasMarker(text) {
  return /\[LQ\]/i.test(text) || /\[LEAD_QUALIFICADO\]/i.test(text);
}

// ─── WEBHOOK PRINCIPAL ───────────────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (body.fromMe || body.isGroup || body.type !== "ReceivedCallback") return;

  const phone = body.phone?.replace(/\D/g, "");
  const text =
    body.text?.message ||
    body.audio?.transcription ||
    body.image?.caption ||
    body.document?.caption;

  if (!phone || !text) return;

  console.log(`📨 ${phone}: ${text.substring(0, 80)}`);

  const session = await getSession(phone);

  // Se já foi qualificado antes, só responde normalmente sem requalificar
  const alreadyQualified = session.qualified;

  session.history.push({ role: "user", content: text });

  // Mantém histórico em no máximo 30 mensagens
  if (session.history.length > 30) session.history = session.history.slice(-30);

  try {
    // Monta contexto para o Claude
    const systemWithContext = alreadyQualified
      ? SOFIA_SYSTEM + "\n\nNOTA: Este lead já foi qualificado anteriormente. Continue a conversa naturalmente, focando em ajudar e responder dúvidas."
      : SOFIA_SYSTEM;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: systemWithContext,
      messages: session.history,
    });

    const rawReply = response.content[0].text;

    // Remove SEMPRE o marcador antes de enviar — independente de onde apareça
    const reply = removeMarker(rawReply);

    // Verifica qualificação
    if (hasMarker(rawReply) && !alreadyQualified) {
      session.qualified = true;
      console.log(`🎯 Lead qualificado: ${phone}`);
      await saveLead(phone, session);
      await notifyManager(phone, session);
    }

    // Salva histórico sem o marcador
    session.history.push({ role: "assistant", content: reply });
    session.lastActivity = Date.now();

    // Persiste sessão no banco
    await saveSession(phone, session);

    // Envia resposta LIMPA para o lead
    await sendWhatsApp(phone, reply);
    console.log(`✅ Sofia respondeu para ${phone}`);

  } catch (err) {
    console.error("Erro ao processar:", err.message);
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
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/leads/:id", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM leads WHERE id = $1", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Lead não encontrado" });
    res.json({ ok: true, lead: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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
        status = COALESCE($1, status), notas = COALESCE($2, notas),
        nome = COALESCE($3, nome), estabelecimento = COALESCE($4, estabelecimento),
        tipo = COALESCE($5, tipo), cidade = COALESCE($6, cidade),
        email = COALESCE($7, email), origem = COALESCE($8, origem), atualizado = NOW()
       WHERE id = $9 RETURNING *`,
      [status, notas, nome, estabelecimento, tipo, cidade, email, origem, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Lead não encontrado" });
    res.json({ ok: true, lead: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/leads/:id", async (req, res) => {
  try {
    const result = await db.query("DELETE FROM leads WHERE id = $1 RETURNING id", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Lead não encontrado" });
    res.json({ ok: true, deleted: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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
  console.log(`📡 Webhook: /webhook/whatsapp`);
  console.log(`📊 API CRM: /api/leads`);
});
