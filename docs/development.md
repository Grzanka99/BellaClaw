# Development

## Install

```bash
bun install
cp .env.example .env
```

Fill in `.env` as described in [Configuration](configuration.md).

## Run

Start once:

```bash
bun run start
```

Start with file watching:

```bash
bun run dev
```

Dev mode tries to seed `.secrets/pi-auth.json` from `.secrets/auth.json`. It skips this step when the
source file is absent and preserves existing Pi credentials.

## Test

Run everything:

```bash
bun test
```

Run one file:

```bash
bun test src/services/memory/index.test.ts
```

Run matching tests:

```bash
bun test --test-name-pattern "my case"
```

## Check Code

Type-check:

```bash
bunx tsc --noEmit
```

Check formatting and lint rules:

```bash
bunx @biomejs/biome check .
```

Apply safe formatting and lint fixes:

```bash
bunx @biomejs/biome check . --write
```
