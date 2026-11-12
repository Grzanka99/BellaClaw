# Development

## Install

```bash
bun install
cp .env.example .env
```

Fill in `.env` as described in [Configuration](configuration.md).

## Run

Start both apps once:

```bash
bun run start
```

Start both apps with file watching:

```bash
bun run dev
```

Run one workspace from the repository root:

```bash
bunx turbo run dev --filter=@bellaclaw/assistant
bunx turbo run dev --filter=@bellaclaw/log-viewer
```

## Signal Simulator

Hold real conversations with the assistant from the shell, with no Signal account:

```bash
bun run dev:sim          # containers, migrations, sim + log viewer + assistant
bun run sim              # lists the commands
```

It needs Podman. Models, MCP and embeddings are real; the database, notes vault and behavior logs
are throwaway and live in `~/.config/bellaclaw-sim`, never in `.env` or your production data. The
first conversation asks you to log in to a model provider once. Steps and commands:
[`.agents/skills/signal-sim/SKILL.md`](../.agents/skills/signal-sim/SKILL.md).

## Test

Run everything:

```bash
bun run test
```

Run one file:

```bash
bun test --cwd apps/assistant src/services/memory/index.test.ts
```

Run matching tests:

```bash
bun test --cwd apps/assistant --test-name-pattern "my case"
```

## Check Code

Type-check:

```bash
bun run typecheck
```

Check formatting and lint rules:

```bash
bun run check
```

Apply safe formatting and lint fixes:

```bash
bunx @biomejs/biome check . --write
```

The assistant owns its Drizzle test preload. Behavior-log and viewer tests run independently and do
not initialize the assistant database.

## GitHub Actions

- Tests + lint: PRs and pushes to `main`.
- Bun: version from `package.json`; frozen installs, lifecycle scripts disabled.
- PR security: OpenCode Go, `opencode-go/glm-5.3-flash`, `max`.
- Security review skips drafts, forks, and Dependabot PRs.
- Setup: install OpenCode GitHub App; set `OPENCODE_API_KEY` Actions secret to Go API key.
- Findings: PR comments only; no workflow failure.
