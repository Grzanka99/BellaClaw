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
| `BELLACLAW_EMBEDDING_BASE_URL` | `http://localhost:11434` | Separate Ollama endpoint for embeddings; Compose uses `http://ollama:11434`. |
| `BELLACLAW_EMBEDDING_MODEL` | `embeddinggemma-2:270m-f32-text` | Embedding model returning 768 dimensions. |
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

**Default:** `embeddinggemma-2:270m-f32-text` — text-only FP32, 768 dimensions.
Tested with Ollama 0.40.8 in Podman, on CPU.

### Import the model once

1. Convert `google/embeddinggemma-2` with
   [llama.cpp's converter](https://github.com/ggml-org/llama.cpp/blob/master/convert_hf_to_gguf.py).
2. Use `--outtype f32 --outfile embeddinggemma-2-270m-f32.gguf`.
3. Import the GGUF into Ollama:

```bash
podman compose pull ollama
podman compose up -d ollama
podman cp embeddinggemma-2-270m-f32.gguf bellaclaw-ollama:/tmp/embeddinggemma-2-270m-f32.gguf
podman exec -i bellaclaw-ollama sh -c 'cat > /tmp/Modelfile' <<'EOF'
FROM /tmp/embeddinggemma-2-270m-f32.gguf
PARAMETER num_ctx 8192
PARAMETER num_thread 2
PARAMETER num_gpu 0
EOF
podman exec bellaclaw-ollama ollama create embeddinggemma-2:270m-f32-text -f /tmp/Modelfile
```

### Rebuild fact embeddings

Back up the database first. To use another model, set `BELLACLAW_EMBEDDING_MODEL` in `.env`.

Stop the assistant, keep Ollama running, then rebuild:

```bash
podman compose stop bellaclaw
podman compose build bellaclaw
bun run server:rebuild-embeddings
podman compose up -d bellaclaw
```

- Reuses existing fact text and the app's embedding client.
- Rebuilds all facts, including superseded and forgotten ones.
- Updates vectors in one transaction. Other data stays intact.
- Failure keeps the previous vectors. Fix the cause and rerun.

**Host command:** Set the endpoint in `.env`, then run:

```bash
bun run --cwd apps/assistant embeddings:rebuild
```

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
