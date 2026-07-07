# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run in production
npm start

# Run in development (auto-restarts on file changes)
npm run dev
```

No build or test step exists — this is a single-file Node.js server.

## Required Environment Variables

Copy `.env.example` and set:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `DATABASE_URL` | PostgreSQL connection string (Railway injects this automatically) |
| `ZAPI_INSTANCE_ID` | Z-API WhatsApp instance ID |
| `ZAPI_TOKEN` | Z-API token |
| `ZAPI_CLIENT_TOKEN` | Z-API client token |
| `MANAGER_PHONE` | Phone number for lead alerts (format: `5531999998888`), used as a fallback in seed data — the value actually read at runtime is `agent_config.manager_phone` per tenant |
| `JWT_SECRET` | Secret used to sign/verify auth JWTs (generate with `openssl rand -hex 64`) |

`PORT` is injected automatically by Railway — do not set it manually.

## Architecture

Everything lives in a single file: `server.js`. It is an ES module (`"type": "module"` in `package.json`). The app is multi-tenant: every operational table carries a `tenant_id`, and no query should run without filtering by it.

### Core flow

1. Z-API sends a webhook POST to `/webhook/whatsapp` when a WhatsApp message is received.
2. `resolveInstance()` looks up `whatsapp_instances` by the payload's `instanceId` to find which tenant (and Z-API credentials) the message belongs to.
3. `loadAgentConfig()` loads that tenant's persona prompt from `agent_config.persona_prompt` (there is no hardcoded system prompt in code).
4. `loadOrCreateContact()` / `loadOrCreateConversation()` resolve the contact and the open conversation; the full message history for that conversation is sent to Claude (`claude-sonnet-4-6`).
5. Claude's response may include hidden markers (`[LQ]`, `[DQ]`, `[RA]`) that update `contacts.etapa_funil` and notify the tenant's manager.
6. The cleaned reply (markers stripped) is sent back via Z-API using the tenant's own credentials, and both sides of the exchange are persisted to `messages`.

### Conversation storage

Conversation history lives in PostgreSQL only, under `conversations` (one open row per tenant+contact, `status = 'aberta'`) and `messages` (one row per message, `remetente` is `contato` / `agente_ia` / `atendente_humano`). There is no in-memory session cache — every webhook call reads/writes straight to the DB.

### Follow-up job

`setInterval` runs `runFollowUpJob()` every 15 minutes. It finds open conversations whose contact hasn't sent a message in a while (based on the contact's own last message, not on Sofia's replies) and sends an AI-generated follow-up at 1h, 24h, and 7d — at most one tier per run, prioritizing the most overdue tier not yet sent. Progress is tracked via `conversations.followup_1h/24h/7d`, which get reset whenever the contact sends a new message (`resetFollowupFlags()`). After the 7-day follow-up the conversation is archived (`status = 'arquivada'`).

### Database tables

`setupDb()` runs on startup and idempotently creates the full multi-tenant schema (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`) — see `schema-multi-tenant.sql` for the annotated reference and `seed-fanfave.sql` for one-time bootstrap data (the Fan Fave tenant row, its `agent_config`, segment template, etc).

- **`tenants`** — one row per client company (Fan Fave is tenant `fa000000-0000-0000-0000-000000000001`).
- **`users`** — CRM logins; `role` is `super_admin` (no `tenant_id`), `tenant_admin`, or `atendente`. `precisa_trocar_senha` forces a password change on first login.
- **`agent_config`** — one row per tenant: the agent's name, tone, persona prompt, and manager phone.
- **`whatsapp_instances`** — one Z-API instance (credentials) per tenant.
- **`contacts`** — leads/customers per tenant; `etapa_funil` drives the funnel state (`novo_lead`, `em_contato`, `demo`, `desqualificado`, ...).
- **`conversations`** / **`messages`** — Sofia's conversation history per contact.
- **`segment_templates`**, **`tenant_modules`**, **`follow_ups`**, **`sites`** — support multi-segment (petshop, etc) and per-tenant site/module config; not yet wired into the Sofia flow.

Legacy tables (`leads`, `sofia_sessions`) predate the multi-tenant migration and are no longer read or written by the app.

### CRM API

JWT-protected REST endpoints under `/api/contacts` (GET list, GET by id, POST, PATCH, DELETE) and `/api/stats`, all scoped to the caller's tenant via `resolveTenantId()` (a `super_admin` must pass `tenant_id` explicitly). Consumed by the external CRM frontend at `fanfave-crm.vercel.app`. Auth endpoints (`/auth/login`, `/auth/trocar-senha`, `/auth/criar-usuario`) issue and consume the JWTs.

### Utility endpoints

- `GET /health` — liveness check
- `POST /send` — manually send a WhatsApp message via Z-API (super_admin only, uses env var credentials)

### AI markers

Sofia's system prompt instructs Claude to append invisible markers at the end of responses:
- `[LQ]` — lead qualified
- `[DQ]` — lead disqualified
- `[RA]` — meeting scheduled

`detectMarkers()` reads these before they are stripped by `removeMarkers()`. Detecting a marker updates `contacts.etapa_funil` via `updateContactEtapaFunil()` and calls `notifyManager()` (sends a WhatsApp alert to the tenant's `agent_config.manager_phone`).
