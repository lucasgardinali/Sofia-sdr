-- ============================================================
-- SCHEMA MULTI-TENANT — Fan Fave + novos clientes (petshop, etc)
-- ============================================================
-- Princípio geral: TODA tabela de dado operacional tem tenant_id.
-- Nenhuma query no código da aplicação deve rodar sem filtrar por tenant_id.
-- O Fan Fave vira o tenant #1 — nada é apagado, só ganha essa coluna.

-- ------------------------------------------------------------
-- 1. TENANTS — cada empresa cliente (incluindo o Fan Fave)
-- ------------------------------------------------------------
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome            VARCHAR(150) NOT NULL,
    slug            VARCHAR(60) UNIQUE NOT NULL,     -- usado em subdomínio: slug.suaplataforma.com
    segmento        VARCHAR(50) NOT NULL,             -- 'food_service', 'petshop', 'farmacia', etc
    plano           VARCHAR(30) DEFAULT 'piloto',      -- 'piloto', 'basico', 'pro'
    status          VARCHAR(20) DEFAULT 'ativo',       -- 'ativo', 'suspenso', 'trial'
    criado_em       TIMESTAMPTZ DEFAULT now(),
    atualizado_em   TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- 2. SEGMENT_TEMPLATES — o "modelo" (conceito do Bolten):
-- editar o modelo afeta só clientes NOVOS daquele segmento,
-- nunca os que já existem (evita quebrar cliente em produção)
-- ------------------------------------------------------------
CREATE TABLE segment_templates (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segmento                VARCHAR(50) UNIQUE NOT NULL,
    nome_exibicao           VARCHAR(100) NOT NULL,       -- 'Petshop', 'Farmácia'
    campos_customizados_schema JSONB NOT NULL DEFAULT '[]', -- define quais campos existem pro segmento
    modulos_padrao          JSONB NOT NULL DEFAULT '[]',    -- ex: ["alerta_vacina", "alerta_banho"]
    persona_prompt_base     TEXT,                            -- prompt-base do agente pro segmento
    site_template_id        VARCHAR(50),                     -- qual template de site usar
    criado_em               TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- 3. USERS — login de cada pessoa que acessa o CRM
-- ------------------------------------------------------------
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants(id),   -- NULL só pro super_admin (Lucas/Luiz)
    nome            VARCHAR(150) NOT NULL,
    email           VARCHAR(150) UNIQUE NOT NULL,
    senha_hash      VARCHAR(255) NOT NULL,
    role                 VARCHAR(20)  NOT NULL DEFAULT 'atendente', -- 'super_admin', 'tenant_admin', 'atendente'
    ativo                BOOLEAN      DEFAULT true,
    precisa_trocar_senha BOOLEAN      DEFAULT true,
    criado_em            TIMESTAMPTZ  DEFAULT now()
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

-- ------------------------------------------------------------
-- 4. AGENT_CONFIG — a "persona" do agente, 1 por tenant
-- (separado do motor/engine, que é compartilhado no código)
-- ------------------------------------------------------------
CREATE TABLE agent_config (
    tenant_id       UUID PRIMARY KEY REFERENCES tenants(id),
    nome_agente     VARCHAR(50) NOT NULL,           -- nome escolhido pelo cliente, livre
    tom_de_voz      VARCHAR(50) DEFAULT 'amigavel',  -- 'formal', 'amigavel', 'divertido'
    persona_prompt  TEXT NOT NULL,                   -- prompt final: base do segmento + customização do cliente
    manager_phone   VARCHAR(20),                     -- número que recebe alertas de lead qualificado (DDI+DDD+número)
    ativo           BOOLEAN DEFAULT true,
    atualizado_em   TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- 5. WHATSAPP_INSTANCES — 1 número/instância Z-API por tenant
-- ------------------------------------------------------------
CREATE TABLE whatsapp_instances (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    instance_id     VARCHAR(100) NOT NULL,   -- ID da instância na Z-API
    token           VARCHAR(255) NOT NULL,   -- token da instância (URL path)
    client_token    VARCHAR(255) NOT NULL,   -- header Client-Token da Z-API
    numero          VARCHAR(20),
    status          VARCHAR(20) DEFAULT 'pendente', -- 'pendente', 'conectado', 'desconectado'
    conectado_em    TIMESTAMPTZ,
    criado_em       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_whatsapp_tenant ON whatsapp_instances(tenant_id);
CREATE UNIQUE INDEX idx_whatsapp_instance_id ON whatsapp_instances(instance_id);

-- ------------------------------------------------------------
-- 6. TENANT_MODULES — quais módulos estão ativos por cliente
-- ------------------------------------------------------------
CREATE TABLE tenant_modules (
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    modulo_key      VARCHAR(50) NOT NULL,   -- 'alerta_vacina', 'alerta_banho', 'agenda'
    ativo           BOOLEAN DEFAULT true,
    config          JSONB DEFAULT '{}',      -- configuração específica do módulo, se precisar
    PRIMARY KEY (tenant_id, modulo_key)
);

-- ------------------------------------------------------------
-- 7. CONTACTS — leads/clientes de cada tenant (pessoa OU pet, etc)
-- ------------------------------------------------------------
CREATE TABLE contacts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    nome                VARCHAR(150) NOT NULL,
    telefone            VARCHAR(20) NOT NULL,
    email               VARCHAR(150),
    etapa_funil         VARCHAR(50) DEFAULT 'novo_lead',
    campos_customizados JSONB DEFAULT '{}',   -- ex: {"pet_nome": "Toby", "pet_especie": "cachorro", "ultima_vacina": "2026-03-10"}
    atendente_id        UUID REFERENCES users(id),
    criado_em           TIMESTAMPTZ DEFAULT now(),
    atualizado_em       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_contacts_tenant ON contacts(tenant_id);
CREATE UNIQUE INDEX idx_contacts_telefone ON contacts(tenant_id, telefone);
-- índice em campos_customizados pra permitir busca rápida (ex: todo mundo com vacina vencendo)
CREATE INDEX idx_contacts_custom_fields ON contacts USING GIN (campos_customizados);

-- ------------------------------------------------------------
-- 8. CONVERSATIONS + MESSAGES — histórico da Sofia com cada contato
-- ------------------------------------------------------------
CREATE TABLE conversations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    contact_id      UUID NOT NULL REFERENCES contacts(id),
    status          VARCHAR(20) DEFAULT 'aberta',  -- 'aberta', 'arquivada'
    ultima_mensagem_em TIMESTAMPTZ DEFAULT now(),
    criado_em       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_conversations_tenant ON conversations(tenant_id);

CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    remetente       VARCHAR(20) NOT NULL,  -- 'contato', 'agente_ia', 'atendente_humano'
    conteudo        TEXT NOT NULL,
    criado_em       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);

-- ------------------------------------------------------------
-- 9. FOLLOW_UPS — agendamento de retorno (vacina, banho, reativação)
-- ------------------------------------------------------------
CREATE TABLE follow_ups (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    contact_id      UUID NOT NULL REFERENCES contacts(id),
    tipo            VARCHAR(50) NOT NULL,   -- 'vacina', 'banho_tosa', 'reativacao'
    data_prevista   DATE NOT NULL,
    status          VARCHAR(20) DEFAULT 'pendente', -- 'pendente', 'enviado', 'concluido'
    criado_em       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_followups_tenant_data ON follow_ups(tenant_id, data_prevista);

-- ------------------------------------------------------------
-- 10. SITES — configuração do site público de cada tenant
-- ------------------------------------------------------------
CREATE TABLE sites (
    tenant_id       UUID PRIMARY KEY REFERENCES tenants(id),
    subdominio      VARCHAR(60) UNIQUE,
    dominio_proprio VARCHAR(150),
    cor_primaria    VARCHAR(7) DEFAULT '#FF6B4A',
    cor_secundaria  VARCHAR(7) DEFAULT '#2EC4B6',
    logo_url        TEXT,
    conteudo        JSONB DEFAULT '{}',   -- textos, serviços, endereço, horário
    publicado       BOOLEAN DEFAULT false,
    atualizado_em   TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- MIGRAÇÃO DO FAN FAVE (tenant #1) — roteiro, não execução direta
-- ============================================================
-- 1. INSERT do Fan Fave em `tenants` (segmento = 'food_service')
-- 2. Nas tabelas JÁ EXISTENTES do Fan Fave (leads, conversas, etc):
--    ALTER TABLE <tabela_existente> ADD COLUMN tenant_id UUID REFERENCES tenants(id);
--    UPDATE <tabela_existente> SET tenant_id = '<uuid-do-fanfave>'; -- popula tudo que já existe
--    ALTER TABLE <tabela_existente> ALTER COLUMN tenant_id SET NOT NULL; -- só depois de confirmar que populou 100%
-- 3. Testar Sofia + CRM do Fan Fave em ambiente de teste ANTES de aplicar em produção
-- 4. Só então: aplicar em produção, com backup do banco tirado antes do passo 2
