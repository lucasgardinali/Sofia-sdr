import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── CONFIGURAÇÕES Z-API ─────────────────────────────────────────────────────
const ZAPI_BASE   = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`;
const ZAPI_CLIENT = process.env.ZAPI_CLIENT_TOKEN;

// ─── PROMPT DA SOFIA ─────────────────────────────────────────────────────────
const SYSTEM = `Você é Sofia, SDR da Fan Fave — plataforma de fidelização para restaurantes, cafés e lanchonetes.

PRODUTO:
- App + PWA: cliente pontua visitas pelo celular sem instalar nada
- Painel web: estabelecimento vê frequência, ticket médio e cria campanhas
- Plano: R$119,90/mês

OBJETIVO: qualificar o lead e agendar uma demo de 20 minutos.

FLUXO (uma pergunta por vez, nesta ordem):
1. Cumprimente e pergunte o nome
2. Pergunte o maior desafio com clientes hoje
3. Pergunte o tipo e tamanho do estabelecimento
4. Pergunte se já usam algum programa de fidelidade
5. Se qualificado → ofereça demo e peça disponibilidade → escreva [LEAD_QUALIFICADO]
6. Se não qualificado → indique materiais e encerre com simpatia

QUALIFICADO quando: estabelecimento físico de alimentação + dono/gerente + aberto há 3+ meses.

REGRAS:
- Máximo 2 linhas por mensagem (é WhatsApp, não email)
- Use o nome da pessoa após saber
- Nunca fale preço antes de entender a dor
- Se perguntarem preço: "depende do perfil — a demo de 20 min esclarece tudo!"
- Objeção "não vão baixar app": temos PWA, funciona no navegador
- Objeção "está caro": R$4/dia, ROI positivo no 1º mês
- Objeção "sem tempo": setup em 1h, cliente pontua sozinho

Tom: caloroso e direto, como uma vendedora experiente — não um robô.`;

// ─── SESSÕES EM MEMÓRIA ───────────────────────────────────────────────────────
const sessions = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, { history: [], qualified: false, lastActivity: Date.now() });
  }
  const s = sessions.get(phone);
  s.lastActivity = Date.now();
  return s;
}

// Limpa sessões inativas há mais de 24h (evita memory leak no Railway)
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [phone, s] of sessions) {
    if (s.lastActivity < cutoff) sessions.delete(phone);
  }
}, 60 * 60 * 1000);

// ─── ENVIAR MENSAGEM PELA Z-API ───────────────────────────────────────────────
async function sendZAPI(phone, message) {
  const res = await fetch(`${ZAPI_BASE}/send-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Client-Token": ZAPI_CLIENT,
    },
    body: JSON.stringify({ phone, message }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Z-API erro ${res.status}: ${err}`);
  }
  return res.json();
}

// ─── NOTIFICAR MANAGER ────────────────────────────────────────────────────────
async function notifyManager(phone, session) {
  if (session.qualified) return;
  session.qualified = true;

  const resumo = session.history
    .slice(-6)
    .map((m) => `${m.role === "user" ? "Lead" : "Sofia"}: ${m.content}`)
    .join("\n");

  console.log(`\n🎯 LEAD QUALIFICADO: ${phone}\n${resumo}\n`);

  if (process.env.MANAGER_PHONE) {
    await sendZAPI(
      process.env.MANAGER_PHONE,
      `🎯 *Lead qualificado pela Sofia!*\n\n📱 ${phone}\n\n${resumo}\n\n_Acesse o CRM para ver o histórico._`
    ).catch((e) => console.error("Erro ao notificar manager:", e.message));
  }
}

// ─── WEBHOOK PRINCIPAL ────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Responde 200 imediatamente (Z-API exige resposta rápida)
  res.sendStatus(200);

  const body = req.body;

  // Ignora: mensagens próprias, grupos, sem texto
  if (body.fromMe || body.isGroup || body.type !== "ReceivedCallback") return;

  const text =
    body.text?.message ||
    body.audio?.transcription ||
    body.image?.caption ||
    body.document?.caption;

  const phone = body.phone;
  if (!text || !phone) return;

  console.log(`📩 [${phone}] ${text}`);

  const session = getSession(phone);
  session.history.push({ role: "user", content: text });

  // Mantém só as últimas 20 mensagens para economizar tokens
  const history = session.history.slice(-20);

  try {
    const response = await claude.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: SYSTEM,
      messages: history,
    });

    const reply = response.content[0]?.text;
    if (!reply) return;

    session.history.push({ role: "assistant", content: reply });

    // Remove tag interna antes de enviar
    const clean = reply.replace("[LEAD_QUALIFICADO]", "").trim();

    await sendZAPI(phone, clean);
    console.log(`📤 [${phone}] ${clean.slice(0, 80)}`);

    if (reply.includes("[LEAD_QUALIFICADO]")) {
      await notifyManager(phone, session);
    }
  } catch (err) {
    console.error("❌ Erro:", err.message);
  }
});

// ─── HEALTH CHECK (Railway verifica isso) ────────────────────────────────────
app.get("/", (_, res) => {
  res.json({
    status: "Sofia online",
    sessions: sessions.size,
    uptime: Math.floor(process.uptime()) + "s",
  });
});

app.get("/health", (_, res) => res.json({ ok: true }));

// ─── START ────────────────────────────────────────────────────────────────────
// Railway injeta a PORT automaticamente — nunca hardcode
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Sofia rodando na porta ${PORT}`));
