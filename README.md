# BellaClaw

My (maybe not) AI Slopware, a vibecoded take on building an AI personal assistant. I tried using OpenClaw but found it burned through tokens fast due to large context (could be a skill issue on my part). So I decided to just build something from scratch -- partly as practice, partly for fun.

Ships with a default "Bellatrix" persona -- a darkly elegant assistant that responds in Polish (I will fix it later).

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) installed
- A Discord bot token
- An opencode API key
- A libSQL database, for example Turso

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `OPENCODE_API_KEY` | Yes | opencode API key |
| `TURSO_CONNECTION_URL` | Yes | libSQL/Turso database connection URL |
| `TURSO_AUTH_TOKEN` | Yes | libSQL/Turso auth token |
| `OPENROUTER_API_KEY` | No | OpenRouter API key, required only when using the OpenRouter provider |
| `TAVILY_API_KEY` | No | Tavily API key, required for web search |
| `OLLAMA_BASE_URL` | No | Ollama base URL (defaults to `http://localhost:11434`) |

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
2. Create a `.env` file there with at least `DISCORD_TOKEN`, `OPENCODE_API_KEY`, `TURSO_CONNECTION_URL`, and `TURSO_AUTH_TOKEN`. Add `TAVILY_API_KEY` if you want web search to work.
3. Start it in the background:

```bash
podman compose up -d --build
```

The container restarts automatically.

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
| `bun test` | Run all tests |
| `bun test <file>` | Run a single test file |
| `bunx tsc --noEmit` | Type-check without emitting |
| `bunx @biomejs/biome check .` | Lint/format check |
| `bunx @biomejs/biome check . --write` | Lint/format auto-fix |

### Message Flow

1. User sends a Discord DM.
2. Three operations run in parallel: importance classification, recent memory retrieval, and AI-driven memory search.
3. The incoming message is saved to the libSQL database with its importance tag.
4. Conversation history (recent + searched memories) is assembled and sent to the AI model along with the system prompt.
5. The AI response is sent back as a Discord DM, then classified and saved to the database asynchronously.
