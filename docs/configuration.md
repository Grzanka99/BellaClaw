# Configuration

BellaClaw reads environment variables from `.env` through Bun.

Start with the example:

```bash
cp .env.example .env
```

Do not commit `.env` or anything under `.secrets/`.

## Default Setup

These values are required for the Discord + OpenCode Go quick start:

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Discord bot token. Without it, Discord is disabled. |
| `OPENCODE_API_KEY` | API key for the default `opencode-go` provider. |
| `TURSO_CONNECTION_URL` | libSQL/Turso database URL. |
| `TURSO_AUTH_TOKEN` | libSQL/Turso authentication token. |

The process can start without a messaging transport, but you need Discord or Signal to talk to
BellaClaw.

## AI and Web

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | — | Required when the active provider is `openrouter`. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL. |
| `TAVILY_API_KEY` | — | Enables web search. |
| `BELLACLAW_AI_CREDENTIALS_PATH` | `.secrets/pi-auth.json` | Pi credential-store path. |

The default provider is `opencode-go`. You can ask BellaClaw in chat to switch between:

- `opencode-go`
- `openai-codex`
- `openrouter`
- `ollama`

OpenAI Codex uses stored OAuth credentials instead of an API key. See
[Deployment](deployment.md#openai-codex-subscription).

## Messaging

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Enables Discord when non-empty. |
| `SIGNAL_ENABLED` | `false` | Enables Signal when set to `true`. |
| `SIGNAL_PHONE_NUMBER` | — | Signal account phone number. Required when Signal is enabled. |
| `SIGNAL_CLI_RPC_URL` | — | `signal-cli-rest-api` URL. Required when Signal is enabled. |
| `BELLACLAW_ACTIVATION_TOKEN` | — | Shared activation token. Blank disables the gate. |

See [Messaging](messaging.md) for setup steps.

## Google Calendar

Calendar needs a service-account key at `.secrets/google-calendar-service-account.json`. Without it,
BellaClaw starts with calendar features unavailable.

The writable calendar is configured per chat with the `!write-calendar <calendarId>` command, not
through an environment variable.

See [Google Calendar](google-calendar.md).

## Behavior Logs

| Variable | Default | Purpose |
| --- | --- | --- |
| `BELLACLAW_LOG_DB_PATH` | `./bellaclaw-logs.db` on the host | Behavior-log SQLite path. |
| `BELLACLAW_LOG_VIEWER_HOSTNAME` | `127.0.0.1` | Standalone viewer bind address. |
| `LOG_CHATID_HMAC_KEY` | Generated beside the database | Key used to hash chat IDs in logs. |

Inside the container, the default database is `/app-data/bellaclaw-logs.db`.

Compose also sets internal paths and safety boundaries. You normally should not override
`BELLACLAW_LOG_DB_ROOT` or `BELLACLAW_AI_CREDENTIALS_PATH` there.

See [Behavior Logs](behavior-logs.md).
