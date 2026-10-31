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
| `BELLACLAW_EMBEDDING_BASE_URL` | `http://localhost:11434` | Ollama server for embeddings; Compose uses `http://ollama:11434`. |
| `BELLACLAW_EMBEDDING_MODEL` | `embeddinggemma-2:270m` | Ollama embedding model. Must return 768 dimensions. |
| `TAVILY_API_KEY` | — | Enables web search. |
| `BELLACLAW_AI_CREDENTIALS_PATH` | `.secrets/pi-auth.json` | Pi credential-store path. |

The default provider is `opencode-go`. You can ask BellaClaw in chat to switch between:

- `opencode-go`
- `openai-codex`
- `openrouter`
- `ollama`

OpenAI Codex uses stored OAuth credentials instead of an API key. See
[Deployment](deployment.md#openai-codex-subscription).

## Embeddings

The default model is `embeddinggemma-2:270m`: EmbeddingGemma 2, text only, Q8_0, 768 dimensions.

Stored fact vectors only match the model that created them. To switch models, set
`BELLACLAW_EMBEDDING_MODEL` in `.env`, then rebuild. The rebuild pulls the model from the Ollama
library, then re-embeds every fact.

```bash
# Compose: stops the assistant, rebuilds, recreates it from the current image
bun run server:rebuild-embeddings

# Local: stop the assistant first
bun run embeddings:rebuild
```

- The new model must also return 768 dimensions.
- The task prefixes and search cutoffs are tuned for EmbeddingGemma 2. Another model needs new
  values in `services/embedding` and `services/memory`.
- EmbeddingGemma 2 needs Ollama 0.40.4 or newer.
- If the rebuild fails, the stored vectors stay unchanged and the assistant stays stopped. Fix the
  cause and run it again, or run `podman compose start bellaclaw` to go back to the previous
  container.
- If the rebuild succeeds and only the restart fails, the vectors have already changed. Run
  `podman compose up -d --force-recreate bellaclaw`, and do not start the previous container.
- When deploying a model change with new code, build first and rebuild instead of running
  `server:update`, so new code never runs against old vectors.

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

The writable calendar is configured per chat with the `!calendar_add-write CALENDAR_ID` command, not
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
