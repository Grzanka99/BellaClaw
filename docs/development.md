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

Dev mode tries to seed `.secrets/pi-auth.json` from `.secrets/auth.json`. It skips this step when the
source file is absent and preserves existing Pi credentials.

Run one workspace from the repository root:

```bash
bunx turbo run dev --filter=@bellaclaw/assistant
bunx turbo run dev --filter=@bellaclaw/log-viewer
```

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

The Tests and Lint workflows run on pull requests and pushes to `main`, using the Bun version in
`package.json` and frozen dependency installs.

OpenCode automatically posts a security review on non-draft pull requests from this repository.
It uses `opencode-go/glm-5.3-flash` with the `max` variant. The OpenCode GitHub App must be installed
on the repository, and the `OPENCODE_API_KEY` Actions secret must contain an OpenCode Go API key.
Fork and Dependabot pull requests skip this review because they cannot access that secret.
Security findings are advisory PR comments; they do not fail the workflow.
