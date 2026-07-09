-- ============================================================
-- SEED FAN FAVE — setup inicial do schema multi-tenant
-- Roda uma vez em banco limpo (produção ou staging).
-- UUID fixo do Fan Fave: fa000000-0000-0000-0000-000000000001
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════════════════════
-- TABELAS
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome            VARCHAR(150) NOT NULL,
    slug            VARCHAR(60)  UNIQUE NOT NULL,
    segmento        VARCHAR(50)  NOT NULL,
    plano           VARCHAR(30)  DEFAULT 'piloto',
    status          VARCHAR(20)  DEFAULT 'ativo',
    criado_em       TIMESTAMPTZ  DEFAULT now(),
    atualizado_em   TIMESTAMPTZ  DEFAULT now()
);

CREATE TABLE IF NOT EXISTS segment_templates (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segmento                   VARCHAR(50)  UNIQUE NOT NULL,
    nome_exibicao              VARCHAR(100) NOT NULL,
    campos_customizados_schema JSONB        NOT NULL DEFAULT '[]',
    modulos_padrao             JSONB        NOT NULL DEFAULT '[]',
    persona_prompt_base        TEXT,
    site_template_id           VARCHAR(50),
    criado_em                  TIMESTAMPTZ  DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID         REFERENCES tenants(id),  -- NULL = super_admin
    nome        VARCHAR(150) NOT NULL,
    email       VARCHAR(150) UNIQUE NOT NULL,
    senha_hash  VARCHAR(255) NOT NULL,
    role                 VARCHAR(20)  NOT NULL DEFAULT 'atendente',
    ativo                BOOLEAN      DEFAULT true,
    precisa_trocar_senha BOOLEAN      DEFAULT true,
    criado_em            TIMESTAMPTZ  DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

CREATE TABLE IF NOT EXISTS agent_config (
    tenant_id      UUID PRIMARY KEY REFERENCES tenants(id),
    nome_agente    VARCHAR(50)  NOT NULL,
    tom_de_voz     VARCHAR(50)  DEFAULT 'amigavel',
    persona_prompt TEXT         NOT NULL,
    definicao_funcao TEXT,
    sobre_empresa  TEXT,
    manager_phone  VARCHAR(20),
    ativo          BOOLEAN      DEFAULT true,
    atualizado_em  TIMESTAMPTZ  DEFAULT now()
);

-- token/client_token ficam cifrados em repouso (AES-256-GCM, ver server.js).
-- webhook_secret é comparado contra ?secret= em /webhook/whatsapp.
CREATE TABLE IF NOT EXISTS whatsapp_instances (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID         NOT NULL REFERENCES tenants(id),
    provider       VARCHAR(20)  NOT NULL DEFAULT 'zapi',
    instance_id    VARCHAR(100) NOT NULL,
    token          TEXT         NOT NULL,
    client_token   TEXT         NOT NULL,
    webhook_secret TEXT,
    numero         VARCHAR(20),
    status         VARCHAR(20)  DEFAULT 'pendente',
    conectado_em   TIMESTAMPTZ,
    criado_em      TIMESTAMPTZ  DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_instances_tenant ON whatsapp_instances(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_instance_id ON whatsapp_instances(instance_id);

CREATE TABLE IF NOT EXISTS tenant_modules (
    tenant_id  UUID        NOT NULL REFERENCES tenants(id),
    modulo_key VARCHAR(50) NOT NULL,
    ativo      BOOLEAN     DEFAULT true,
    config     JSONB       DEFAULT '{}',
    PRIMARY KEY (tenant_id, modulo_key)
);

CREATE TABLE IF NOT EXISTS contacts (
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
);
CREATE INDEX        IF NOT EXISTS idx_contacts_tenant        ON contacts(tenant_id);
-- DROP + CREATE garante que o índice seja UNIQUE mesmo se já existir como simples
DROP INDEX IF EXISTS idx_contacts_telefone;
CREATE UNIQUE INDEX idx_contacts_telefone ON contacts(tenant_id, telefone);
CREATE INDEX        IF NOT EXISTS idx_contacts_custom_fields ON contacts USING GIN (campos_customizados);

CREATE TABLE IF NOT EXISTS conversations (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID        NOT NULL REFERENCES tenants(id),
    contact_id         UUID        NOT NULL REFERENCES contacts(id),
    status             VARCHAR(20) DEFAULT 'aberta',
    ultima_mensagem_em TIMESTAMPTZ DEFAULT now(),
    criado_em          TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON conversations(tenant_id);

CREATE TABLE IF NOT EXISTS messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id),
    conversation_id UUID        NOT NULL REFERENCES conversations(id),
    remetente       VARCHAR(20) NOT NULL,  -- 'contato', 'agente_ia', 'atendente_humano'
    conteudo        TEXT        NOT NULL,
    criado_em       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

CREATE TABLE IF NOT EXISTS follow_ups (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID        NOT NULL REFERENCES tenants(id),
    contact_id    UUID        NOT NULL REFERENCES contacts(id),
    tipo          VARCHAR(50) NOT NULL,
    data_prevista DATE        NOT NULL,
    status        VARCHAR(20) DEFAULT 'pendente',
    criado_em     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_followups_tenant_data ON follow_ups(tenant_id, data_prevista);

CREATE TABLE IF NOT EXISTS sites (
    tenant_id       UUID PRIMARY KEY REFERENCES tenants(id),
    subdominio      VARCHAR(60)  UNIQUE,
    dominio_proprio VARCHAR(150),
    cor_primaria    VARCHAR(7)   DEFAULT '#FF6B4A',
    cor_secundaria  VARCHAR(7)   DEFAULT '#2EC4B6',
    logo_url        TEXT,
    conteudo        JSONB        DEFAULT '{}',
    publicado       BOOLEAN      DEFAULT false,
    atualizado_em   TIMESTAMPTZ  DEFAULT now()
);

-- ════════════════════════════════════════════════════════════
-- TENANT: Fan Fave
-- ════════════════════════════════════════════════════════════

INSERT INTO tenants (id, nome, slug, segmento, plano, status)
VALUES (
    'fa000000-0000-0000-0000-000000000001',
    'Fan Fave',
    'fanfave',
    'food_service',
    'piloto',
    'ativo'
)
ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════════════
-- SEGMENT_TEMPLATE: food_service
-- prompt_base contém as regras genéricas do segmento;
-- o prompt completo da Sofia fica em agent_config.persona_prompt
-- ════════════════════════════════════════════════════════════

INSERT INTO segment_templates (segmento, nome_exibicao, persona_prompt_base, modulos_padrao)
VALUES (
    'food_service',
    'Food Service',
    $PROMPT$Você é um assistente comercial de uma plataforma de fidelização digital para negócios de food service (restaurantes, lanchonetes, bares, cafeterias, padarias, food trucks e similares).

SEU OBJETIVO: qualificar o lead e agendar uma conversa com o time comercial.

SEU FLUXO DE CONVERSA:
1. Saudação calorosa e apresentação rápida
2. Perguntar o nome da pessoa
3. Perguntar qual é o estabelecimento e o segmento
4. Apresentar a plataforma focando na dor (cliente que não volta)
5. Perguntar se faz sentido para o negócio deles
6. Se interesse demonstrado: propor conversa com o time e perguntar melhor horário
7. Se interesse alto ou reunião agendada: marcar como qualificado

REGRAS:
- Seja natural, calorosa e direta — como uma atendente humana real
- Mensagens curtas (máximo 3 parágrafos)
- Use emojis com moderação (1-2 por mensagem no máximo)
- Nunca invente funcionalidades que não existem
- Não force a venda — qualifique primeiro
- Responda sempre em português brasileiro$PROMPT$,
    '["reativacao"]'::jsonb
)
ON CONFLICT (segmento) DO NOTHING;

-- ════════════════════════════════════════════════════════════
-- AGENT_CONFIG: Sofia
-- persona_prompt = SOFIA_SYSTEM atual do server.js
-- manager_phone  = substituir pelo valor real de MANAGER_PHONE
-- ════════════════════════════════════════════════════════════

INSERT INTO agent_config (tenant_id, nome_agente, tom_de_voz, persona_prompt, manager_phone, ativo)
VALUES (
    'fa000000-0000-0000-0000-000000000001',
    'Sofia',
    'amigavel',
    $PROMPT$Você é Sofia, assistente comercial do Fan Fave — plataforma de fidelização digital para negócios de food service (restaurantes, lanchonetes, bares, cafeterias, padarias, food trucks e similares) em Montes Claros e região.

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

NUNCA mencione esses marcadores na conversa. Eles são invisíveis para o usuário.$PROMPT$,
    'SUBSTITUIR_MANAGER_PHONE',  -- env: MANAGER_PHONE (formato: 5531999998888)
    true
)
ON CONFLICT (tenant_id) DO NOTHING;

-- ════════════════════════════════════════════════════════════
-- WHATSAPP_INSTANCES: placeholder
-- Preencher com as credenciais reais da Z-API antes de subir.
-- ════════════════════════════════════════════════════════════

-- token/client_token entram em texto puro aqui só neste seed manual — o
-- próximo boot do server.js (migrateWhatsappCredentials, ver server.js)
-- cifra automaticamente e gera o webhook_secret pra essa linha.
INSERT INTO whatsapp_instances (tenant_id, instance_id, token, client_token, status)
VALUES (
    'fa000000-0000-0000-0000-000000000001',
    'SUBSTITUIR_ZAPI_INSTANCE_ID',   -- env: ZAPI_INSTANCE_ID
    'SUBSTITUIR_ZAPI_TOKEN',         -- env: ZAPI_TOKEN
    'SUBSTITUIR_ZAPI_CLIENT_TOKEN',  -- env: ZAPI_CLIENT_TOKEN
    'pendente'
)
ON CONFLICT (instance_id) DO NOTHING;

COMMIT;
