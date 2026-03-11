# AGENTS.md

## Purpose

This is a small Bun + TypeScript Discord assistant project.
Prefer small, targeted changes that preserve the current structure and naming style.

## Project Layout

- `src/index.ts` is the Bun entrypoint.
- `src/services/memory/` contains persistent memory logic and helpers.
- `src/services/sqlite-storage/index.ts` contains a simple SQLite-backed key-value store.
- `src/utils/` contains shared utilities like logging and async queueing.

## Bun Commands

- Install dependencies: `bun install`
- Start once: `bun run src/index.ts`
- Start via script: `bun run start`
- Dev/watch mode: `bun run dev`
- Run tests: `bun test`
- Run tests via script: `bun run test`
- Run one test file: `bun test path/to/file.test.ts`
- Run tests by name: `bun test --test-name-pattern "my case"`
- Typecheck: `bunx tsc --noEmit`
- Biome check: `bunx @biomejs/biome check .`
- Biome auto-fix: `bunx @biomejs/biome check . --write`

## Test Notes

- This repository currently has no test files.
- Bun only discovers files like `*.test.ts`, `*.spec.ts`, `*_test_*.ts`, or `*_spec_*.ts`.
- Do not assume new work requires tests; add them only when explicitly requested.

## Validation Expectations

- This is a pet project; keep validation lightweight and practical.
- Do not assume lint, typecheck, or tests are always fully green.
- Lint and formatting cleanup may be handled manually by the maintainer.
- If an unrelated issue blocks a command, mention it briefly instead of broad cleanup.

## Project-Specific Conventions

- Package manager/runtime is `bun`.
- TypeScript uses ESM (`"type": "module"`) with `strict: true` and `noEmit: true`.
- Module resolution is `bundler` with `allowImportingTsExtensions: true`.
- Formatting and linting are handled by Biome.
- SQLite usage relies on `bun:sqlite`.

## Naming And Types

- Shared type aliases use `T*` prefixes.
- Enums use `E*` names.
- Zod schemas use `S*` names.
- Singleton accessors use `instance` getters.
- Reuse existing shared aliases like `TOption<T>` when they fit.

## Code Style

- Use double quotes and semicolons, matching the current codebase.
- Keep imports sorted the way Biome expects.
- Use `import type` for type-only imports.
- Prefer relative imports within `src/`.
- Use `as const` for stable constants when helpful.
- Avoid `any`; prefer `unknown` at boundaries.

## Error Handling And State

- Prefer explicit early returns.
- Preserve current API style when methods return `undefined` or `boolean` for recoverable failures.
- Use the shared `Logger` base class or `logger` utility for operational logs when practical.
- Be careful with queueing and singleton state; this codebase uses both.
- Keep SQLite queries parameterized.

## Cursor / Copilot Rules

- No `.cursor/rules/` rules were found.
- No `.cursorrules` file was found.
- No `.github/copilot-instructions.md` file was found.
