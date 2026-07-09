import express from "express";
import cors from "cors";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

// ─── CLIENTES ────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── SETUP DO BANCO ───────────────────────────────────────────────────────────
// Idempotente: cria o schema multi-tenant (ver schema-multi-tenant.sql) se ainda
// não existir. Tabelas legadas (leads, sofia_sessions) não são mais geridas aqui
// — o app roda inteiramente sobre tenants/contacts/conversations/messages.
async function setupDb() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS tenants (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nome            VARCHAR(150) NOT NULL,
      slug            VARCHAR(60)  UNIQUE NOT NULL,
      segmento        VARCHAR(50)  NOT NULL,
      plano           VARCHAR(30)  DEFAULT 'piloto',
      status          VARCHAR(20)  DEFAULT 'ativo',
      criado_em       TIMESTAMPTZ  DEFAULT now(),
      atualizado_em   TIMESTAMPTZ  DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS segment_templates (
      id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      segmento                   VARCHAR(50)  UNIQUE NOT NULL,
      nome_exibicao              VARCHAR(100) NOT NULL,
      campos_customizados_schema JSONB        NOT NULL DEFAULT '[]',
      modulos_padrao             JSONB        NOT NULL DEFAULT '[]',
      persona_prompt_base        TEXT,
      site_template_id           VARCHAR(50),
      criado_em                  TIMESTAMPTZ  DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id            UUID         REFERENCES tenants(id),
      nome                 VARCHAR(150) NOT NULL,
      email                VARCHAR(150) UNIQUE NOT NULL,
      senha_hash           VARCHAR(255) NOT NULL,
      role                 VARCHAR(20)  NOT NULL DEFAULT 'atendente',
      ativo                BOOLEAN      DEFAULT true,
      precisa_trocar_senha BOOLEAN      DEFAULT true,
      criado_em            TIMESTAMPTZ  DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)`,
    `CREATE TABLE IF NOT EXISTS agent_config (
      tenant_id      UUID PRIMARY KEY REFERENCES tenants(id),
      nome_agente    VARCHAR(50)  NOT NULL,
      tom_de_voz     VARCHAR(50)  DEFAULT 'amigavel',
      persona_prompt TEXT         NOT NULL,
      manager_phone  VARCHAR(20),
      ativo          BOOLEAN      DEFAULT true,
      atualizado_em  TIMESTAMPTZ  DEFAULT now()
    )`,
    `ALTER TABLE agent_config ADD COLUMN IF NOT EXISTS definicao_funcao TEXT`,
    `ALTER TABLE agent_config ADD COLUMN IF NOT EXISTS sobre_empresa    TEXT`,
    `CREATE TABLE IF NOT EXISTS whatsapp_instances (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    UUID         NOT NULL REFERENCES tenants(id),
      instance_id  VARCHAR(100) NOT NULL,
      token        VARCHAR(255) NOT NULL,
      client_token VARCHAR(255) NOT NULL,
      numero       VARCHAR(20),
      status       VARCHAR(20)  DEFAULT 'pendente',
      conectado_em TIMESTAMPTZ,
      criado_em    TIMESTAMPTZ  DEFAULT now()
    )`,
    `CREATE INDEX        IF NOT EXISTS idx_whatsapp_tenant      ON whatsapp_instances(tenant_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_instance_id ON whatsapp_instances(instance_id)`,
    // Fase 5: provider (zapi/meta), segredo de webhook por tenant, colunas de
    // credencial ampliadas pra TEXT (o blob cifrado + tokens longos de outros
    // providers no futuro), e 1 instância por tenant (necessário pro upsert
    // em ON CONFLICT (tenant_id) do endpoint de connect).
    `ALTER TABLE whatsapp_instances ADD COLUMN IF NOT EXISTS provider VARCHAR(20) NOT NULL DEFAULT 'zapi'`,
    `ALTER TABLE whatsapp_instances ADD COLUMN IF NOT EXISTS webhook_secret TEXT`,
    `ALTER TABLE whatsapp_instances ALTER COLUMN token TYPE TEXT`,
    `ALTER TABLE whatsapp_instances ALTER COLUMN client_token TYPE TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_instances_tenant ON whatsapp_instances(tenant_id)`,
    `CREATE TABLE IF NOT EXISTS tenant_modules (
      tenant_id  UUID        NOT NULL REFERENCES tenants(id),
      modulo_key VARCHAR(50) NOT NULL,
      ativo      BOOLEAN     DEFAULT true,
      config     JSONB       DEFAULT '{}',
      PRIMARY KEY (tenant_id, modulo_key)
    )`,
    `CREATE TABLE IF NOT EXISTS contacts (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id           UUID         NOT NULL REFERENCES tenants(id),
      nome                VARCHAR(150) NOT NULL,
      telefone            VARCHAR(20)  NOT NULL,
      email               VARCHAR(150),
      etapa_funil         VARCHAR(50)  DEFAULT 'novo_lead',
      campos_customizados JSONB        DEFAULT '{}',
      atendente_id        UUID         REFERENCES users(id),
      criado_em           TIMESTAMPTZ  DEFAULT now(),
      atualizado_em       TIMESTAMPTZ  DEFAULT now()
    )`,
    `CREATE INDEX        IF NOT EXISTS idx_contacts_tenant        ON contacts(tenant_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_telefone      ON contacts(tenant_id, telefone)`,
    `CREATE INDEX        IF NOT EXISTS idx_contacts_custom_fields ON contacts USING GIN (campos_customizados)`,
    `CREATE TABLE IF NOT EXISTS conversations (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id          UUID        NOT NULL REFERENCES tenants(id),
      contact_id         UUID        NOT NULL REFERENCES contacts(id),
      status             VARCHAR(20) DEFAULT 'aberta',
      ultima_mensagem_em TIMESTAMPTZ DEFAULT now(),
      criado_em          TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON conversations(tenant_id)`,
    // Flags de follow-up por conversa — substituem sofia_sessions.followup_1h/24h/7d
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS followup_1h  BOOLEAN DEFAULT false`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS followup_24h BOOLEAN DEFAULT false`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS followup_7d  BOOLEAN DEFAULT false`,
    `CREATE TABLE IF NOT EXISTS messages (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       UUID        NOT NULL REFERENCES tenants(id),
      conversation_id UUID        NOT NULL REFERENCES conversations(id),
      remetente       VARCHAR(20) NOT NULL,
      conteudo        TEXT        NOT NULL,
      criado_em       TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)`,
    `CREATE TABLE IF NOT EXISTS follow_ups (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     UUID        NOT NULL REFERENCES tenants(id),
      contact_id    UUID        NOT NULL REFERENCES contacts(id),
      tipo          VARCHAR(50) NOT NULL,
      data_prevista DATE        NOT NULL,
      status        VARCHAR(20) DEFAULT 'pendente',
      criado_em     TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_followups_tenant_data ON follow_ups(tenant_id, data_prevista)`,
    `CREATE TABLE IF NOT EXISTS sites (
      tenant_id       UUID PRIMARY KEY REFERENCES tenants(id),
      subdominio      VARCHAR(60)  UNIQUE,
      dominio_proprio VARCHAR(150),
      cor_primaria    VARCHAR(7)   DEFAULT '#FF6B4A',
      cor_secundaria  VARCHAR(7)   DEFAULT '#2EC4B6',
      logo_url        TEXT,
      conteudo        JSONB        DEFAULT '{}',
      publicado       BOOLEAN      DEFAULT false,
      atualizado_em   TIMESTAMPTZ  DEFAULT now()
    )`,
  ];

  for (const sql of statements) await db.query(sql);

  await migrateWhatsappCredentials();

  console.log("✅ Banco configurado");
}

// ─── CREDENCIAIS DE WHATSAPP (criptografia em repouso) ───────────────────────
// AES-256-GCM na aplicação — a chave nunca precisa viver no banco, e GCM
// autentica o conteúdo (detecta adulteração), não só cifra.
const CRED_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY
  ? Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY, "hex")
  : null;

// Diagnóstico temporário (Fase 5 rollout): imprime só um fingerprint da
// chave — nunca o valor — pra confirmar por hash que o env var do Railway
// bate byte a byte com a chave usada para cifrar os dados existentes.
// Remover depois que o rollout for confirmado.
if (CRED_KEY) {
  console.log(`🔑 CRED_KEY: ${CRED_KEY.length} bytes, fingerprint ${crypto.createHash("sha256").update(CRED_KEY).digest("hex").slice(0, 12)}`);
} else {
  console.warn("⚠️ CREDENTIALS_ENCRYPTION_KEY não definida");
}

function encryptCredential(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", CRED_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function decryptCredential(stored) {
  const [ivB64, tagB64, dataB64] = String(stored).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", CRED_KEY, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return plain.toString("utf8");
}

// Detecta o formato "iv:tag:cipher" gerado por encryptCredential(), pra
// distinguir de um valor legado ainda em texto puro.
function isEncrypted(value) {
  if (typeof value !== "string") return false;
  const parts = value.split(":");
  if (parts.length !== 3) return false;
  try {
    const iv = Buffer.from(parts[0], "base64");
    const tag = Buffer.from(parts[1], "base64");
    return iv.length === 12 && tag.length === 16;
  } catch {
    return false;
  }
}

// Nunca devolver o valor completo em resposta de API — só os últimos 4 chars.
function maskCredential(plain) {
  const str = String(plain || "");
  if (str.length <= 4) return "••••";
  return "••••" + str.slice(-4);
}

// Roda em todo boot (idempotente): cifra qualquer token/client_token ainda em
// texto puro (dados de antes da Fase 5) e gera webhook_secret pra linhas que
// ainda não têm. Só toca linhas que precisam.
async function migrateWhatsappCredentials() {
  if (!CRED_KEY) {
    console.warn("⚠️ CREDENTIALS_ENCRYPTION_KEY não definida — pulando migração de credenciais de WhatsApp");
    return;
  }
  const rows = (await db.query(`SELECT id, token, client_token, webhook_secret FROM whatsapp_instances`)).rows;
  for (const row of rows) {
    const sets = [];
    const values = [];
    if (!isEncrypted(row.token)) {
      values.push(encryptCredential(row.token));
      sets.push(`token = $${values.length}`);
    }
    if (!isEncrypted(row.client_token)) {
      values.push(encryptCredential(row.client_token));
      sets.push(`client_token = $${values.length}`);
    }
    if (!row.webhook_secret) {
      values.push(crypto.randomBytes(32).toString("hex"));
      sets.push(`webhook_secret = $${values.length}`);
    }
    if (sets.length) {
      values.push(row.id);
      await db.query(`UPDATE whatsapp_instances SET ${sets.join(", ")} WHERE id = $${values.length}`, values);
      console.log(`🔐 whatsapp_instances ${row.id}: ${sets.map(s => s.split(" =")[0]).join(", ")} atualizado(s)`);
    }
  }
}

// Compara dois segredos em tempo constante sem lançar exceção quando os
// tamanhos diferem (ex.: alguém manda um ?secret= curto/errado).
function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
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

// ─── MULTI-TENANT: RESOLUÇÃO E CONTEXTO ──────────────────────────────────────

async function resolveInstance(instanceId) {
  try {
    const result = await db.query(
      `SELECT tenant_id, token, client_token, webhook_secret FROM whatsapp_instances WHERE instance_id = $1`,
      [instanceId]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return {
      tenantId: row.tenant_id,
      token: decryptCredential(row.token),
      clientToken: decryptCredential(row.client_token),
      webhookSecret: row.webhook_secret,
    };
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

// Chamado quando o contato manda uma nova mensagem, para que o job de
// follow-up volte a poder disparar (1h/24h/7d) caso ele fique em silêncio de novo.
async function resetFollowupFlags(conversationId) {
  await db.query(
    `UPDATE conversations SET followup_1h = false, followup_24h = false, followup_7d = false WHERE id = $1`,
    [conversationId]
  );
}

// SOFIA_SYSTEM removido — prompt mora em agent_config.persona_prompt no banco.

// ─── Z-API ───────────────────────────────────────────────────────────────────
// creds = { instanceId, token, clientToken } — se omitido, usa env vars (usado por /send)
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
async function generateFollowUp(nomeAgente, contexto, tipo) {
  const prompts = {
    "1h":  `Você é ${nomeAgente}. O lead parou de responder há 1 hora. Com base na conversa abaixo, escreva UMA mensagem curta e calorosa verificando se a pessoa ainda está por aí. Seja leve, não pressione. Máximo 2 linhas. NÃO use marcadores técnicos.\n\nConversa:\n${contexto}`,
    "24h": `Você é ${nomeAgente}. O lead parou de responder há mais de 24 horas. Com base na conversa abaixo, escreva UMA mensagem para retomar o contato. Relembre brevemente o valor do produto e convide para continuar. Tom amigável, sem pressão. Máximo 3 linhas. NÃO use marcadores técnicos.\n\nConversa:\n${contexto}`,
    "7d":  `Você é ${nomeAgente}. O lead parou de responder há 7 dias. Com base na conversa abaixo, escreva UMA mensagem direta e objetiva de última tentativa. Mencione que ainda tem interesse em ajudar e deixe uma abertura clara. Máximo 3 linhas. NÃO use marcadores técnicos.\n\nConversa:\n${contexto}`,
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

async function findWhatsAppCreds(tenantId) {
  const r = await db.query(
    `SELECT instance_id, token, client_token FROM whatsapp_instances WHERE tenant_id = $1 LIMIT 1`,
    [tenantId]
  );
  if (!r.rows.length) return null;
  return {
    instanceId: r.rows[0].instance_id,
    token: decryptCredential(r.rows[0].token),
    clientToken: decryptCredential(r.rows[0].client_token),
  };
}

// Job roda a cada 15 minutos. Considera "silêncio" o tempo desde a última
// mensagem do CONTATO (remetente = 'contato'), não desde a última mensagem
// enviada (que inclui as respostas automáticas da Sofia e os próprios follow-ups).
async function runFollowUpJob() {
  console.log("⏰ Rodando job de follow-up...");
  try {
    const result = await db.query(`
      SELECT
        c.id AS conversation_id, c.tenant_id, c.followup_1h, c.followup_24h, c.followup_7d,
        ct.telefone, ct.nome,
        lm.criado_em AS last_contato_em
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      JOIN LATERAL (
        SELECT criado_em FROM messages
        WHERE conversation_id = c.id AND remetente = 'contato'
        ORDER BY criado_em DESC LIMIT 1
      ) lm ON true
      WHERE c.status = 'aberta'
        AND NOT (c.followup_1h AND c.followup_24h AND c.followup_7d)
        AND lm.criado_em < NOW() - INTERVAL '55 minutes'
    `);

    const now = new Date();
    const agentConfigCache = new Map();
    const credsCache = new Map();

    for (const row of result.rows) {
      const diffHours = (now - new Date(row.last_contato_em)) / (1000 * 60 * 60);
      const diffDays  = diffHours / 24;

      // No máximo um envio por execução — prioriza o nível mais atrasado
      // ainda não enviado (evita disparar 1h + 24h juntos se o job ficou parado).
      let tipo = null;
      if (diffDays >= 7 && !row.followup_7d) tipo = "7d";
      else if (diffDays >= 1 && !row.followup_24h) tipo = "24h";
      else if (diffHours >= 1 && !row.followup_1h) tipo = "1h";
      if (!tipo) continue;

      if (!agentConfigCache.has(row.tenant_id)) {
        agentConfigCache.set(row.tenant_id, await loadAgentConfig(row.tenant_id).catch(() => null));
      }
      const agentConfig = agentConfigCache.get(row.tenant_id);
      if (!agentConfig) continue;

      if (!credsCache.has(row.tenant_id)) {
        credsCache.set(row.tenant_id, await findWhatsAppCreds(row.tenant_id));
      }
      const creds = credsCache.get(row.tenant_id);
      if (!creds) continue;

      const historico = await loadRecentMessages(row.conversation_id, 6);
      const contexto = historico.map((m) => `${m.role === "user" ? "Lead" : agentConfig.nome_agente}: ${m.content}`).join("\n");

      console.log(`📩 Follow-up ${tipo} → ${row.telefone} [tenant ${row.tenant_id}]`);
      const msg = await generateFollowUp(agentConfig.nome_agente, contexto, tipo);
      if (!msg) continue;

      await sendWhatsApp(row.telefone, msg, creds);
      await saveMessage(row.tenant_id, row.conversation_id, "agente_ia", msg);

      // Marca também os tiers inferiores como satisfeitos — sem isso, mandar o
      // de 24h não impede o de 1h de disparar de novo numa próxima execução.
      if (tipo === "1h") {
        await db.query(`UPDATE conversations SET followup_1h = true WHERE id = $1`, [row.conversation_id]);
      }
      if (tipo === "24h") {
        await db.query(`UPDATE conversations SET followup_1h = true, followup_24h = true WHERE id = $1`, [row.conversation_id]);
      }
      if (tipo === "7d") {
        await db.query(`UPDATE conversations SET followup_1h = true, followup_24h = true, followup_7d = true WHERE id = $1`, [row.conversation_id]);
        await archiveConversation(row.conversation_id);
      }
    }

    console.log(`✅ Job concluído — ${result.rows.length} conversas verificadas`);
  } catch (err) {
    console.error("Erro no job de follow-up:", err.message);
  }
}

// DISABLE_FOLLOWUP_JOB=true impede até o registro do setInterval — usado ao
// rodar o servidor localmente contra o banco de produção pra testes, pra
// nunca disparar follow-ups reais sem querer.
if (process.env.DISABLE_FOLLOWUP_JOB === "true") {
  console.log("⏸️ Job de follow-up desabilitado (DISABLE_FOLLOWUP_JOB=true)");
} else {
  setInterval(runFollowUpJob, 15 * 60 * 1000);
}

// ─── WEBHOOK PRINCIPAL ────────────────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  const body = req.body;
  if (body.fromMe || body.isGroup || body.type !== "ReceivedCallback") return res.sendStatus(200);

  // Resolve tenant a partir da instância Z-API que recebeu a mensagem — só
  // uma leitura, necessária pra saber qual segredo comparar no próximo passo.
  const instance = await resolveInstance(body.instanceId);
  if (!instance) {
    console.warn(`⚠️ Instância desconhecida: ${body.instanceId}`);
    return res.sendStatus(200); // não vaza se o instanceId existe ou não
  }

  // Valida o segredo do webhook ANTES de qualquer escrita em contacts/
  // conversations/messages. A Z-API é configurada (no painel, por tenant)
  // pra chamar .../webhook/whatsapp?secret=<webhook_secret>.
  if (!timingSafeEqualStrings(req.query.secret, instance.webhookSecret)) {
    console.warn(`⚠️ Segredo de webhook inválido para instância ${body.instanceId}`);
    return res.status(401).json({ ok: false, error: "Assinatura de webhook inválida" });
  }

  res.sendStatus(200);

  const phone = body.phone?.replace(/\D/g, "");
  const text  = body.text?.message || body.audio?.transcription || body.image?.caption || body.document?.caption;
  if (!phone || !text) return;

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
    await resetFollowupFlags(conversation.id);

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

// ════════════════════════════════════════════════════════════════════════════
// ─── AGENT CONFIG (persona do agente, editável no CRM) ─────────────────────
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/agent-config", auth("super_admin", "tenant_admin"), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const r = await db.query(
      `SELECT nome_agente, tom_de_voz, definicao_funcao, sobre_empresa FROM agent_config WHERE tenant_id = $1`,
      [tenantId]
    );
    if (!r.rows.length) return res.json({ ok: true, exists: false });
    res.json({ ok: true, exists: true, ...r.rows[0] });
  } catch (err) {
    if (err.message.includes("tenant_id obrigatório")) return res.status(400).json({ ok: false, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch("/api/agent-config", auth("super_admin", "tenant_admin"), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const { nome_agente, tom_de_voz, definicao_funcao, sobre_empresa } = req.body;
    if (!nome_agente || !definicao_funcao || !sobre_empresa)
      return res.status(400).json({ ok: false, error: "nome_agente, definicao_funcao e sobre_empresa são obrigatórios" });
    const personaPrompt = `${definicao_funcao}\n\n${sobre_empresa}`;
    const result = await db.query(
      `INSERT INTO agent_config (tenant_id, nome_agente, tom_de_voz, definicao_funcao, sobre_empresa, persona_prompt)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id) DO UPDATE SET
         nome_agente      = $2,
         tom_de_voz       = $3,
         definicao_funcao = $4,
         sobre_empresa    = $5,
         persona_prompt   = $6,
         atualizado_em    = NOW()
       RETURNING nome_agente, tom_de_voz, definicao_funcao, sobre_empresa`,
      [tenantId, nome_agente, tom_de_voz || "amigavel", definicao_funcao, sobre_empresa, personaPrompt]
    );
    res.json({ ok: true, ...result.rows[0] });
  } catch (err) {
    if (err.message.includes("tenant_id obrigatório")) return res.status(400).json({ ok: false, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ─── WHATSAPP (conectar instância por tenant) ───────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/whatsapp/connect", auth("super_admin", "tenant_admin"), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const { provider, instanceId, token, clientToken, numero } = req.body;
    const prov = provider || "zapi";
    if (prov === "zapi" && (!instanceId || !token || !clientToken))
      return res.status(400).json({ ok: false, error: "instanceId, token e clientToken são obrigatórios para provider zapi" });

    const existing = await db.query(`SELECT webhook_secret FROM whatsapp_instances WHERE tenant_id = $1`, [tenantId]);
    const webhookSecret = existing.rows[0]?.webhook_secret || crypto.randomBytes(32).toString("hex");

    const result = await db.query(
      `INSERT INTO whatsapp_instances (tenant_id, provider, instance_id, token, client_token, numero, status, conectado_em, webhook_secret)
       VALUES ($1,$2,$3,$4,$5,$6,'conectado',NOW(),$7)
       ON CONFLICT (tenant_id) DO UPDATE SET
         provider     = $2,
         instance_id  = $3,
         token        = $4,
         client_token = $5,
         numero       = $6,
         status       = 'conectado',
         conectado_em = NOW(),
         webhook_secret = COALESCE(whatsapp_instances.webhook_secret, $7)
       RETURNING provider, numero, status, webhook_secret`,
      [tenantId, prov, instanceId, encryptCredential(token), encryptCredential(clientToken), numero || null, webhookSecret]
    );
    const row = result.rows[0];
    res.status(201).json({
      ok: true,
      provider: row.provider,
      numero: row.numero,
      status: row.status,
      tokenPreview: maskCredential(token),
      webhookUrl: `${req.protocol}://${req.get("host")}/webhook/whatsapp?secret=${row.webhook_secret}`,
    });
  } catch (err) {
    if (err.message.includes("tenant_id obrigatório")) return res.status(400).json({ ok: false, error: err.message });
    if (err.code === "23505") return res.status(409).json({ ok: false, error: "instanceId já está em uso por outro tenant" });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/whatsapp/status", auth("super_admin", "tenant_admin"), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const r = await db.query(
      `SELECT provider, numero, status, conectado_em, token FROM whatsapp_instances WHERE tenant_id = $1`,
      [tenantId]
    );
    if (!r.rows.length) return res.json({ ok: true, connected: false });
    const row = r.rows[0];
    res.json({
      ok: true,
      connected: true,
      provider: row.provider,
      numero: row.numero,
      status: row.status,
      conectadoEm: row.conectado_em,
      tokenPreview: maskCredential(decryptCredential(row.token)),
    });
  } catch (err) {
    if (err.message.includes("tenant_id obrigatório")) return res.status(400).json({ ok: false, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── UTILITÁRIOS ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", service: "Sofia Fan Fave", timestamp: new Date().toISOString() }));

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
  console.log(`📊 API CRM: /api/contacts`);
  console.log(process.env.DISABLE_FOLLOWUP_JOB === "true" ? `⏸️ Follow-up job: desabilitado` : `⏰ Follow-up job: a cada 15 minutos`);
});
