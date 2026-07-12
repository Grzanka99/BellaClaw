# BellaClaw

My (maybe not) AI Slopware, a vibecoded take on building an AI personal assistant. I tried using OpenClaw but found it burned through tokens fast due to large context (could be a skill issue on my part). So I decided to just build something from scratch -- partly as practice, partly for fun.

Ships with a default "Bellatrix" persona -- a darkly elegant assistant that responds in Polish (I will fix it later).

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) installed
- An opencode API key
- A libSQL database, for example Turso

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENCODE_API_KEY` | Yes | opencode API key |
| `TURSO_CONNECTION_URL` | Yes | libSQL/Turso database connection URL |
| `TURSO_AUTH_TOKEN` | Yes | libSQL/Turso auth token |
| `OPENROUTER_API_KEY` | No | OpenRouter API key, required only when using the OpenRouter provider |
| `TAVILY_API_KEY` | No | Tavily API key, required for web search |
| `OLLAMA_BASE_URL` | No | Ollama base URL (defaults to `http://localhost:11434`) |
| `SIGNAL_ENABLED` | No | Set to `true` after Signal is linked and verified; keep `false` by default |
| `SIGNAL_PHONE_NUMBER` | No | Signal phone number used by `signal-cli-rest-api` when Signal is enabled |
| `SIGNAL_CLI_RPC_URL` | No | Signal API URL. Compose sets this to `http://signal-cli:8080`; use `http://127.0.0.1:8080` only when running BellaClaw on the host |
| `SIGNAL_CLI_DATA_DIR` | No | Optional host fallback data directory when running Signal API outside compose |

### Install Dependencies

```bash
bun install
```

### Run

```bash
bun run start
```

### Run With Podman In Background

1. Copy the repo to the server.
2. Create a `.env` file there with at least `OPENCODE_API_KEY`, `TURSO_CONNECTION_URL`, and `TURSO_AUTH_TOKEN`. Add `TAVILY_API_KEY` if you want web search to work. Keep `SIGNAL_ENABLED=false` until linking is complete.
3. Start it in the background:

```bash
podman compose up -d --build
```

The container restarts automatically.

### Signal Setup With Podman

Signal support uses `bbernhard/signal-cli-rest-api` as a linked secondary device. Linking is an operator/deployment step; BellaClaw does not link during startup. The Signal API is published on `127.0.0.1:8080` only so you can open the linking pages from the host browser without exposing the API publicly.

1. Start BellaClaw and the Signal sidecar:

```bash
podman compose --profile signal up -d --build
```

2. Open the QR link in your browser:

```text
http://127.0.0.1:8080/v1/qrcodelink?device_name=bellaclaw
```

3. Scan it from Signal on your phone: **Settings → Linked devices → Link new device**.
4. Verify the account is registered in the sidecar by opening:

```text
http://127.0.0.1:8080/v1/accounts
```

5. Set `SIGNAL_ENABLED=true` and `SIGNAL_PHONE_NUMBER=<your Signal number>` in `.env`, then recreate the services so the updated environment is applied:

```bash
podman compose --profile signal up -d --build
```

Keep the `signal-cli-data` volume. It stores Signal link/session state; deleting it requires linking again.

For local development without compose, run `signal-cli-rest-api` bound to localhost only and point BellaClaw at it:

```bash
podman run -d --name bellaclaw-signal-cli -e MODE=json-rpc -p 127.0.0.1:8080:8080 -v "${SIGNAL_CLI_DATA_DIR:-./signal-cli-data}:/home/.local/share/signal-cli" bbernhard/signal-cli-rest-api:0.100-rootless
```

Use `SIGNAL_CLI_RPC_URL=http://127.0.0.1:8080` for this non-compose setup. The compose setup sets `SIGNAL_CLI_RPC_URL=http://signal-cli:8080` for the sidecar container. Do not expose this port publicly.

### Dev Mode (file-watch)

```bash
bun run dev
```

## Commands

| Command | Description |
|---|---|
| `bun install` | Install dependencies |
| `bun run start` | Start the bot |
| `bun run dev` | Start with file-watch (auto-restart) |
| `podman compose exec bellaclaw bun run logs:turn -- <turnId>` | Show behavior events for a turn in the container |
| `bun test` | Run all tests |
| `bun test <file>` | Run a single test file |
| `bunx tsc --noEmit` | Type-check without emitting |
| `bunx @biomejs/biome check .` | Lint/format check |
| `bunx @biomejs/biome check . --write` | Lint/format auto-fix |

To query a host-mounted behavior log database, set `BELLACLAW_LOG_DB_PATH` to its path before running `bun run logs:turn -- <turnId>`.

### Message Flow

1. User sends a Signal direct message.
2. Three operations run in parallel: importance classification, recent memory retrieval, and AI-driven memory search.
3. The incoming message is saved to the libSQL database with its importance tag.
4. Conversation history (recent + searched memories) is assembled and sent to the AI model along with the system prompt.
5. The AI response is sent back as a Signal direct message, then classified and saved to the database asynchronously.
