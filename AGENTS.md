# Rules

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

# Project

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
- After edits, run Biome auto-fix and Biome check on changed files when possible, instead of whole repo.

## Naming Conventions

- Type aliases: `T*` prefix (e.g. `TMemory`, `TOption<T>`)
- Enums: `E*` prefix (e.g. `EMemoryImportance`, `EMemoryAuthor`)
- Zod schemas: `S*` prefix (e.g. `SMemory`, `SSaveArgs`)
- Singleton accessor: `public static get instance()` — always this name, no variants

## AsyncQueue

All SQLite operations must go through `this.queue.enqueue()`. Never call `this.db.*` directly outside of an enqueued callback.

## Zod Usage

Always use `safeParse` and branch on `.success` — never use `.parse` (throws on failure).

## AI Tool Schemas

AI-facing tool schemas use TypeBox imported through `@earendil-works/pi-ai`. Keep `S*` schema
names and derive argument types with `Static<typeof SArguments>`. Zod remains appropriate for
non-AI persistence, settings, logging, memory, and configuration schemas.

## Environment Variables

Use `Bun.env.*` — never `process.env`.

## Logging

- In classes: use `private logger = createLogger("PREFIX")` and call `this.logger.info/warning/error/message()`
- Outside classes: import and use the `logger` utility directly
- Never use raw `console.log` inside service files

## AI Tool Structure

Each tool lives in its own directory under `src/services/ai/tools/`:

```
src/services/ai/tools/<tool-name>/
  definition.ts    — exports the tool name and schema-backed Pi metadata
  handler.ts       — exports the TypeBox schema, argument type, and domain validation/conversion
  instructions.xml — detailed instructions for the AI on when/how to use the tool
```

- `definition.ts`: Use `createToolDefinition()` with an `S*` TypeBox schema.
- `handler.ts`: Treat tool arguments as structured data. TypeBox/Pi validates shape; keep cross-field domain validation and transport conversion here. Never apply `JSON.parse` to tool arguments.
- `executable.ts`: Centrally binds definition metadata and handlers to BellaClaw services as Pi `AgentTool`s. Keep service execution and tool-result shaping here.
- `instructions.xml`: XML format with `<purpose>`, `<tool>`, `<usage_rules>`, and `<examples>` sections.

## Scope Rules

- Do not introduce any shims or compatibility layers. It is work in progress app
- Do not change anything not directly asked.
- Do not fix type errors in files outside the current task's scope, even if you notice them.
- If you find errors that are caused by current task changes, ask for permission to fix them
- If a type error in an unrelated file blocks your task, report it instead of silently fixing it.
- NEVER use types cast - 'as Type' - outside of tests
- Instead of `some-type | undefined` use `TOption<some-type>`
- Prefer braces even if statement has one line
    ```
    if (true) {
        return undefined
    }
    ```
- Avoid ternary operators. Prefer explicit `if`/`else` statements for conditional logic.
- Do not add single-use helper functions for trivial logic. Keep one-off predicates, transforms, and short code blocks inline. Extract only when the helper names a distinct domain concept, isolates a separate concern, or replaces a bulky/noisy block.
