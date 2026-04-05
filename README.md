# BellaClaw

My take on building an AI personal assistant. I tried using OpenClaw but found it burned through tokens fast due to large context (could be a skill issue on my part). So I decided to just build something from scratch -- partly as practice, partly for fun.

Ships with a default "Bellatrix" persona -- a darkly elegant assistant that responds in Polish (I will fix it later).

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) installed
- A Discord bot token
- An OpenRouter API key

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key |
| `OLLAMA_BASE_URL` | No | Ollama base URL (defaults to `http://localhost:11434`) |

### Install Dependencies

```bash
bun install
```

### Run

```bash
bun run start
```

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
3. The incoming message is saved to SQLite with its importance tag.
4. Conversation history (recent + searched memories) is assembled and sent to the AI model along with the system prompt.
5. The AI response is sent back as a Discord DM, then classified and saved to the database asynchronously.
