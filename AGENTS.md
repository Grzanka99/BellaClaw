# AGENTS.md

## Purpose

Small Bun + TypeScript Discord assistant. Prefer small, targeted changes that preserve the current structure and naming style.

## Commands

- Install dependencies: `bun install`
- Start once: `bun run src/index.ts`
- Start via script: `bun run start`
- Dev/watch mode: `bun run dev`
- Run all tests: `bun test`
- Run one test file: `bun test src/services/memory/index.test.ts`
- Run tests by name: `bun test --test-name-pattern "my case"`
- Typecheck: `bunx tsc --noEmit`
- Biome check: `bunx @biomejs/biome check .`
- Biome auto-fix: `bunx @biomejs/biome check . --write`

## Naming Conventions

- Type aliases: `T*` prefix (e.g. `TMemory`, `TOption<T>`)
- Enums: `E*` prefix (e.g. `EMemoryImportance`, `EMemoryAuthor`)
- Zod schemas: `S*` prefix (e.g. `SMemory`, `SSaveArgs`)
- Singleton accessor: `public static get instance()` — always this name, no variants

## Singleton Pattern

All singletons follow this exact shape:

```ts
export class FooSingleton extends Logger {
  private static _instance: FooSingleton;

  private constructor() {
    super("FOO");
  }

  public static get instance(): FooSingleton {
    if (!FooSingleton._instance) {
      FooSingleton._instance = new FooSingleton();
    }
    return FooSingleton._instance;
  }
}
```

## AsyncQueue

All SQLite operations must go through `this.queue.enqueue()`. Never call `this.db.*` directly outside of an enqueued callback.

## Zod Usage

Always use `safeParse` and branch on `.success` — never use `.parse` (throws on failure).

## Environment Variables

Use `Bun.env.*` — never `process.env`.

## Logging

- In classes: extend `Logger` and use `this.logger.info/warning/error/message()`
- Outside classes: import and use the `logger` utility directly
- Never use raw `console.log` inside service files

## Scope Rules

- Do not change anything not directly asked.
- Do not fix type errors in files outside the current task's scope, even if you notice them.
- If a type error in an unrelated file blocks your task, report it instead of silently fixing it.
- Do not modify stub methods (those with `throw "Not implemented"`) unless explicitly asked to implement them.
- Do not modify existing test files under any circumstances.
- NEVER use types cast - 'as Type' - outside of tests
