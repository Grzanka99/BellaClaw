# BellaClaw

My (maybe not) AI Slopware, a vibecoded take on building an AI personal assistant. I tried using
OpenClaw but found it burned through tokens fast due to large context (could be a skill issue on my
part). So I decided to just build something from scratch -- partly as practice, partly for fun.

## What It Does

- Chats through Discord DMs or Signal
- Remembers past conversations
- Creates reminders and recurring tasks
- Reads and manages Google Calendar events
- Searches and fetches the web
- Supports OpenCode Go, OpenAI Codex, OpenRouter, and Ollama

## Quick Start

You need:

- [Bun](https://bun.sh)
- A Discord bot token
- An OpenCode API key
- A libSQL database, such as Turso

Set up the project:

```bash
bun install
cp .env.example .env
```

Open `.env` and fill in:

```dotenv
DISCORD_TOKEN=
OPENCODE_API_KEY=
TURSO_CONNECTION_URL=
TURSO_AUTH_TOKEN=
```

See [Messaging](docs/messaging.md) for Discord token setup.

Start BellaClaw:

```bash
bun run start
```

This starts both the assistant and the behavior-log viewer. Then send the bot a Discord DM or open
`http://127.0.0.1:8989` to inspect behavior logs.

## Repository Layout

- `apps/assistant` — messaging, AI runtime, scheduling, and the Turso/Drizzle database
- `apps/log-viewer` — read-only behavior-log web interface
- `packages/behavior-logs` — shared behavior-log SQLite contract and access APIs
- `packages/shared` — cross-workspace primitives: `TOption`, `AsyncQueue`, the logger, and
  `REPOSITORY_ROOT`

Bun workspaces own dependencies and Turborepo coordinates tasks from the repository root.

## Documentation

- [Configuration](docs/configuration.md) — environment variables and AI providers
- [Development](docs/development.md) — local commands, tests, and code checks
- [Deployment](docs/deployment.md) — Podman deployment and OpenAI Codex auth
- [Messaging](docs/messaging.md) — Discord and Signal setup
- [Google Calendar](docs/google-calendar.md) — calendar access and setup
- [Behavior Logs](docs/behavior-logs.md) — log viewer, CLI, and security
- [Architecture](docs/architecture.md) — message flow and AI runtime

## License

BellaClaw is available under the MIT License.
