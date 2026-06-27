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
// Guarda histórico de conversa por número de telefone
const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutos de inatividade limpa a sessão

function getSession(phone) {
  const now = Date.now();
  if (!sessions.has(phone)) {
    sessions.set(phone, { history: [], lastActivity: now, qualified: false });
  }
  const session = sessions.get(phone);
  session.lastActivity = now;
  return session;
}

// Limpa sessões expiradas a cada 10 minutos
setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TTL) sessions.delete(phone);
  }
}, 10 * 60 * 1000);

// ─── SISTEMA DE PROMPT DA SOFIA ──────────────────────────────────────────────
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

// ─── ENVIO VIA Z-API ─────────────────────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  const instanceId = process.env.ZAPI_INSTANCE_ID;
  const token = process.env.ZAPI_TOKEN;
  const clientToken = process.env.ZAPI_CLIENT_TOKEN;

  const res = await fetch(
    `https://api.z-api.io/instances/${instanceId}/token/${token}/send-text`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Client-Token": clientToken,
      },
      body: JSON.stringify({ phone, message }),
    }
  );

  const data = await res.json();
  if (!res.ok) console.error("Z-API erro:", data);
  return data;
}

// ─── SALVAR LEAD NO BANCO ────────────────────────────────────────────────────
async function saveLead(phone, session) {
  const summary = session.history
    .slice(-6)
    .map((m) => `${m.role === "user" ? "Lead" : "Sofia"}: ${m.content}`)
    .join("\n");

  // Tenta extrair nome do histórico (heurística simples)
  const nomeMatch = session.history
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join(" ")
    .match(/\b([A-Z][a-záéíóúãõâêîôûç]+(?:\s[A-Z][a-záéíóúãõâêîôûç]+)?)\b/);

  const nome = nomeMatch ? nomeMatch[1] : "Lead WhatsApp";

  try {
    await db.query(
      `INSERT INTO leads
        (nome, whatsapp, estabelecimento, tipo, status, origem, notas, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (whatsapp) DO UPDATE SET
        status = EXCLUDED.status,
        notas = EXCLUDED.notas`,
      [
        nome,
        phone,
        "Via WhatsApp",
        "Food service",
        "novo",
        "whatsapp",
        summary,
      ]
    );
    console.log(`✅ Lead salvo no banco: ${phone}`);
  } catch (err) {
    console.error("Erro ao salvar lead:", err.message);
  }
}

// ─── NOTIFICAR MANAGER ───────────────────────────────────────────────────────
async function notifyManager(phone, session) {
  const summary = session.history
    .slice(-4)
    .map((m) => `${m.role === "user" ? "👤" : "🤖"} ${m.content}`)
    .join("\n");

  const msg = `🎯 *Lead qualificado pela Sofia!*\n\n📱 Telefone: ${phone}\n\n💬 Último contexto:\n${summary}\n\n_Acesse o CRM para ver o histórico completo._`;

  if (process.env.MANAGER_PHONE) {
    await sendWhatsApp(process.env.MANAGER_PHONE, msg);
  }
}

// ─── WEBHOOK PRINCIPAL ───────────────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200); // responde imediatamente pra Z-API não dar timeout

  const body = req.body;

  // Ignora mensagens enviadas pelo próprio número e grupos
  if (body.fromMe || body.isGroup || body.type !== "ReceivedCallback") return;

  const phone = body.phone?.replace(/\D/g, "");
  const text =
    body.text?.message ||
    body.audio?.transcription ||
    body.image?.caption ||
    body.document?.caption;

  if (!phone || !text) return;

  console.log(`📨 Mensagem de ${phone}: ${text}`);

  const session = getSession(phone);

  // Adiciona mensagem do usuário ao histórico
  session.history.push({ role: "user", content: text });

  // Mantém histórico em no máximo 20 mensagens para controlar custo
  if (session.history.length > 20) session.history = session.history.slice(-20);

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: SOFIA_SYSTEM,
      messages: session.history,
    });

    let reply = response.content[0].text;

    // Verifica se lead foi qualificado
    if (reply.includes("[LEAD_QUALIFICADO]") && !session.qualified) {
      session.qualified = true;
      reply = reply.replace("[LEAD_QUALIFICADO]", "").trim();
      await saveLead(phone, session);
      await notifyManager(phone, session);
    }

    // Adiciona resposta da Sofia ao histórico
    session.history.push({ role: "assistant", content: reply });

    // Envia resposta via WhatsApp
    await sendWhatsApp(phone, reply);
    console.log(`✅ Sofia respondeu para ${phone}`);
  } catch (err) {
    console.error("Erro ao processar mensagem:", err.message);
  }
});

// ─── ENDPOINTS UTILITÁRIOS ───────────────────────────────────────────────────

// Health check — Railway usa para verificar se o serviço está vivo
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Sofia Fan Fave", timestamp: new Date().toISOString() });
});

// Listar sessões ativas (debug)
app.get("/sessions", (req, res) => {
  const list = [];
  for (const [phone, session] of sessions.entries()) {
    list.push({
      phone,
      messages: session.history.length,
      qualified: session.qualified,
      lastActivity: new Date(session.lastActivity).toISOString(),
    });
  }
  res.json({ total: list.length, sessions: list });
});

// Disparar mensagem ativa (para campanhas ou testes)
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

// ─── INICIA SERVIDOR ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 Sofia online na porta ${PORT}`);
  console.log(`📡 Aguardando webhooks da Z-API...`);
});
