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
| `MANAGER_PHONE` | Phone number for lead alerts (format: `5531999998888`) |

`PORT` is injected automatically by Railway — do not set it manually.

## Architecture

Everything lives in a single file: `server.js`. It is an ES module (`"type": "module"` in `package.json`).

### Core flow

1. Z-API sends a webhook POST to `/webhook/whatsapp` when a WhatsApp message is received.
2. The webhook loads or creates a session for the sender's phone number.
3. The full conversation history is sent to Claude (`claude-sonnet-4-6`) with the `SOFIA_SYSTEM` prompt.
4. Claude's response may include hidden markers (`[LQ]`, `[DQ]`, `[RA]`) that trigger CRM actions.
5. The cleaned reply (markers stripped) is sent back via Z-API and the session is persisted to PostgreSQL.

### Session management

Sessions are stored **both** in memory (`Map`) and in PostgreSQL (`sofia_sessions` table). On first message, the session is loaded from DB; subsequent messages in the same process hit the in-memory cache. The in-memory TTL is 30 minutes. `followupStatus` drives the state machine: `ativo` → `qualificado` / `reuniao_agendada` / `desqualificado` / `encerrado`.

### Follow-up job

`setInterval` runs `runFollowUpJob()` every 15 minutes. It queries sessions where the lead has been silent and sends AI-generated follow-up messages at 1h, 24h, and 7d intervals. After the 7-day follow-up, `followup_status` is set to `encerrado`.

### Database tables

- **`sofia_sessions`** — conversation history (JSONB), qualification state, follow-up flags, timestamps.
- **`leads`** — CRM records with status (`novo`, `contato`, `demo`, `negociacao`, `fechado`, `arquivado`) and origem (`instagram`, `landing`, `whatsapp`, `indicacao`, `manual`, `diagnostico`). `whatsapp` column is the unique key.

`setupDb()` runs on startup and uses `ADD COLUMN IF NOT EXISTS` + `DROP/ADD CONSTRAINT` to migrate the schema forward safely.

### CRM API

REST endpoints under `/api/leads` (GET list, GET by id, POST, PATCH, DELETE) and `/api/stats`. Consumed by the external CRM frontend at `fanfave-crm.vercel.app`.

### Utility endpoints

- `GET /health` — liveness check
- `GET /sessions` — inspect in-memory sessions
- `POST /send` — manually send a WhatsApp message via Z-API

### AI markers

Sofia's system prompt instructs Claude to append invisible markers at the end of responses:
- `[LQ]` — lead qualified
- `[DQ]` — lead disqualified
- `[RA]` — meeting scheduled

`detectMarkers()` reads these before they are stripped by `removeMarkers()`. Detecting a marker triggers `saveLead()` and `notifyManager()` (sends a WhatsApp alert to `MANAGER_PHONE`).
