# Cron Service Implementation Plan

## Overview

Persistent cron service for BellaClaw. Supports recurring jobs via cron expressions and one-time events at absolute timestamps. Uses an event emitter pattern — jobs emit named events with job context. Persisted to SQLite so jobs survive restarts.

**No external dependencies.** Cron expression parsing is implemented in-house.

**Do NOT wire into `src/index.ts`** — the consumer will do that manually later.

---

## Architecture

### Files

| File | Purpose |
|------|---------|
| `src/services/cron/types.ts` | Enums, Zod schemas, inferred types |
| `src/services/cron/parser.ts` | Pure-function cron expression parser |
| `src/services/cron/index.ts` | `CronSingleton` — main service class |
| `src/services/cron/index.test.ts` | Tests (TDD — written before implementation) |

### Conventions (from AGENTS.md)

- Type aliases: `T*` prefix (e.g. `TCronJob`, `TJobContext`)
- Enums: `E*` prefix (e.g. `ECronJobType`)
- Zod schemas: `S*` prefix (e.g. `SCronJob`, `SScheduleArgs`)
- Singleton accessor: `public static get instance()`
- All SQLite ops go through `this.queue.enqueue()`
- Zod: always `safeParse`, never `.parse`
- Logger: `private logger = createLogger("CRON")`
- Env vars: `Bun.env.*`
- Use `TOption<T>` instead of `T | undefined`

---

## Detailed Type Definitions (`types.ts`)

### Enum: `ECronJobType`

```typescript
enum ECronJobType {
  Recurring = "recurring",
  OneTime = "onetime",
}
```

### Zod Schema: `SCronJob`

Represents a persisted row in the `cron_jobs` table:

```typescript
SCronJob = z.object({
  id: z.number(),
  name: z.string(),            // unique job name, also used as event name
  type: z.enum(ECronJobType),
  pattern: z.string().nullable(), // cron expression (null for one-time)
  nextRunAt: z.coerce.date(),
  lastRunAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})
```

### Zod Schema: `SScheduleArgs`

Input for scheduling a recurring job:

```typescript
SScheduleArgs = z.object({
  name: z.string(),
  pattern: z.string(),  // cron expression like "*/5 * * * *"
})
```

### Zod Schema: `SScheduleOnceArgs`

Input for scheduling a one-time event:

```typescript
SScheduleOnceArgs = z.object({
  name: z.string(),
  fireAt: z.coerce.date(),  // absolute timestamp
})
```

### Type: `TJobContext`

Emitted with every job event:

```typescript
type TJobContext = {
  name: string;
  type: ECronJobType;
  pattern: TOption<string>;
  lastRunAt: TOption<Date>;
  nextRunAt: Date;
}
```

### Inferred types

```typescript
type TCronJob = z.infer<typeof SCronJob>
type TScheduleArgs = z.infer<typeof SScheduleArgs>
type TScheduleOnceArgs = z.infer<typeof SScheduleOnceArgs>
```

### Error type

```typescript
type TCronError = {
  operation: "schedule" | "unschedule" | "read" | "tick";
  error: unknown;
}
```

---

## Cron Expression Parser (`parser.ts`)

### Supported syntax

Standard 5-field cron: `minute hour day-of-month month day-of-week`

| Field | Allowed values | Special characters |
|-------|---------------|-------------------|
| Minute | 0-59 | `*`, `,`, `-`, `/` |
| Hour | 0-23 | `*`, `,`, `-`, `/` |
| Day of month | 1-31 | `*`, `,`, `-`, `/` |
| Month | 1-12 | `*`, `,`, `-`, `/` |
| Day of week | 0-6 (0=Sunday) | `*`, `,`, `-`, `/` |

### Exports

```typescript
// Validates a cron pattern string. Returns true if valid, false otherwise.
function isValidCron(pattern: string): boolean

// Given a cron pattern and a reference Date, returns the next Date the pattern matches.
// Throws if the pattern is invalid — caller must validate with isValidCron first.
function getNextFireTime(pattern: string, from: Date): Date
```

### Algorithm for `getNextFireTime`

1. Parse each of the 5 fields into a `Set<number>` of allowed values
2. Start from `from` date, advance by 1 minute (reset seconds to 0)
3. Walk forward: check month -> day-of-month -> day-of-week -> hour -> minute
4. If a field doesn't match, advance that field to the next matching value and reset all smaller fields
5. Cap iteration to prevent infinite loops (e.g. max 4 years forward)

### Field parsing rules

- `*` — all values in range
- `N` — single value
- `N-M` — range (inclusive)
- `*/N` — step from range start
- `N-M/S` — step within range
- `A,B,C` — list (each element can be a value, range, or step)

---

## CronSingleton (`index.ts`)

### Class structure

```
class CronSingleton extends EventEmitter {
  private static _instance: CronSingleton
  private static DB_FILE = "cron.db"      // overridable in tests
  private db: Database                      // bun:sqlite
  private queue: AsyncQueue
  private logger: TLogger
  private tickInterval: TOption<Timer>      // polling interval handle

  private constructor()
  public static get instance()
  public setup(pollIntervalMs?: number)     // default 10_000 (10s)
  public async schedule(args: TScheduleArgs): Promise<TCronJob | TCronError>
  public async scheduleOnce(args: TScheduleOnceArgs): Promise<TCronJob | TCronError>
  public async unschedule(name: string): Promise<TCronJob | TCronError>
  public async getJob(name: string): Promise<TOption<TCronJob>>
  public async getAllJobs(): Promise<TCronJob[] | TCronError>
  public destroy(): void
}
```

### DB table: `cron_jobs`

```sql
CREATE TABLE IF NOT EXISTS cron_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  pattern TEXT,
  nextRunAt INTEGER NOT NULL,
  lastRunAt INTEGER,
  createdAt INTEGER NOT NULL
)
```

- `name` is UNIQUE — scheduling with the same name overwrites
- Dates stored as epoch milliseconds (INTEGER), same convention as Memory service
- `pattern` is NULL for one-time events

### Constructor

1. Create `AsyncQueue`
2. Open SQLite database at `CronSingleton.DB_FILE`
3. Enqueue table creation (`CREATE TABLE IF NOT EXISTS`)

### `setup(pollIntervalMs?)`

1. Start a `setInterval` that calls `tick()` every `pollIntervalMs` ms
2. Run one immediate `tick()` to catch any missed jobs from downtime

### `tick()` (private)

1. Query all jobs `WHERE nextRunAt <= $now`
2. For each matched job:
   a. Emit `job.name` event with `TJobContext` payload
   b. If `type === "recurring"`: compute new `nextRunAt` via `getNextFireTime(pattern, now)`, update row with new `nextRunAt` and `lastRunAt = now`
   c. If `type === "onetime"`: delete the row
3. All DB operations go through `this.queue.enqueue()`

### `schedule(args)`

1. Validate `pattern` with `isValidCron()`; return `TCronError` if invalid
2. Compute `nextRunAt` from `getNextFireTime(pattern, new Date())`
3. Upsert into `cron_jobs` (INSERT OR REPLACE on `name`)
4. Return the inserted `TCronJob`

### `scheduleOnce(args)`

1. Validate `fireAt` is in the future; return `TCronError` if not
2. Insert with `type = "onetime"`, `pattern = null`, `nextRunAt = fireAt`
3. Return the inserted `TCronJob`

### `unschedule(name)`

1. `DELETE FROM cron_jobs WHERE name = $name RETURNING *`
2. Return the deleted `TCronJob`, or `TCronError` if not found

### `getJob(name)`

1. `SELECT * FROM cron_jobs WHERE name = $name`
2. Return parsed `TCronJob` or `undefined`

### `getAllJobs()`

1. `SELECT * FROM cron_jobs ORDER BY nextRunAt ASC`
2. Return parsed `TCronJob[]`

### `destroy()`

1. `clearInterval(this.tickInterval)`
2. Close the database

### Event emitter usage

```typescript
const cron = CronSingleton.instance;
cron.setup();
cron.on("daily-cleanup", (ctx: TJobContext) => {
  // handle the event
});
cron.schedule({ name: "daily-cleanup", pattern: "0 3 * * *" });
```

---

## Test Plan (`index.test.ts`)

TDD approach: write tests first, then implement. Three rounds of increasing complexity.

### Test infrastructure

Same pattern as `src/services/memory/index.test.ts`:
- `TEST_DB = "test-cron.db"`
- `resetCronInstance(dbPath)` helper to reset singleton + set DB path
- `beforeEach`: delete test DB, reset instance
- `afterEach`: call `destroy()`, delete test DB, restore default DB path

### Round 1 — Basic (write tests, then implement types.ts + minimal index.ts)

- [ ] **Singleton**: `instance` returns a `CronSingleton`
- [ ] **Singleton**: returns the same instance on multiple calls
- [ ] **Schedule recurring**: `schedule()` returns a `TCronJob` with correct fields
- [ ] **Schedule one-time**: `scheduleOnce()` returns a `TCronJob` with `type = "onetime"`
- [ ] **Event fires (recurring)**: schedule a `"*/1 * * * *"` job, call `tick()` after setting `nextRunAt` to past, verify event emitted with `TJobContext`
- [ ] **Event fires (one-time)**: schedule a one-time job with `fireAt` in the past, call `tick()`, verify event emitted

### Round 2 — Persistence & lifecycle (expand tests, then expand implementation)

- [ ] **One-time removed after firing**: after tick, `getJob()` returns `undefined`
- [ ] **Recurring updates nextRunAt**: after tick, `getJob()` shows new future `nextRunAt` and `lastRunAt` set
- [ ] **Unschedule**: removes job, returns it; subsequent `getJob()` returns `undefined`
- [ ] **Unschedule missing**: returns `TCronError` for unknown job name
- [ ] **getAllJobs**: returns all scheduled jobs ordered by `nextRunAt`
- [ ] **Persistence**: schedule a job, destroy instance, create new instance, job still exists via `getJob()`
- [ ] **Duplicate name overwrites**: scheduling with same name updates the existing job

### Round 3 — Cron parser (write parser tests, then implement parser.ts)

- [ ] **isValidCron**: valid patterns return true (`"* * * * *"`, `"0 9 * * 1-5"`, `"*/5 * * * *"`)
- [ ] **isValidCron**: invalid patterns return false (`"* * *"`, `"60 * * * *"`, `"abc"`, `""`)
- [ ] **getNextFireTime**: `"* * * * *"` from any time → next minute
- [ ] **getNextFireTime**: `"0 * * * *"` → next hour at :00
- [ ] **getNextFireTime**: `"30 9 * * *"` → next 09:30
- [ ] **getNextFireTime**: `"0 0 1 * *"` → first of next month at midnight
- [ ] **getNextFireTime**: `"*/15 * * * *"` → next quarter-hour
- [ ] **getNextFireTime**: `"0 9 * * 1-5"` → next weekday at 09:00
- [ ] **getNextFireTime**: `"0 9 * * 1,3,5"` → next Mon/Wed/Fri at 09:00
- [ ] **getNextFireTime**: ranges `"10-20 * * * *"` → next minute in 10-20 range
- [ ] **getNextFireTime**: step in range `"10-30/5 * * * *"` → 10, 15, 20, 25, 30

---

## Implementation Order

1. Write Round 1 tests (basic skeleton tests)
2. Create `types.ts` with enums, schemas, types
3. Create stub `parser.ts` with `isValidCron` (return true) and `getNextFireTime` (return next minute)
4. Implement `index.ts` — constructor, `setup()`, `schedule()`, `scheduleOnce()`, basic `tick()`
5. Run Round 1 tests, iterate until green
6. **Ask user for review**
7. Write Round 2 tests (persistence, lifecycle)
8. Implement `unschedule()`, `getJob()`, `getAllJobs()`, `destroy()`, persistence behavior in `tick()`
9. Run Round 2 tests, iterate until green
10. **Ask user for review**
11. Write Round 3 tests (parser)
12. Implement full `parser.ts` — field parsing, `getNextFireTime` algorithm
13. Run Round 3 tests, iterate until green
14. **Ask user for review**
15. Run full suite: `bun test`, `bunx tsc --noEmit`, `bunx @biomejs/biome check .`
