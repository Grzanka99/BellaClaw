---
name: architecture
description: BellaClaw's event-driven architecture in apps/assistant. Use before adding or changing an event, command, consumer or handler, a database write, or a call from one service to another.
---

# architecture

Services in `apps/assistant/src/services` talk through one durable event log, the **bus**
(`events/index.ts`). The catalog of every message type is `events/catalog.ts`. A service writes
only its own tables and reaches another service with a message: a **fact** it publishes, or a
**command** it requests. The direct calls that remain are the allow-list below.

## Facts and commands

- A **fact** (`EEventKind.Event`) says what happened, past tense: `turn.completed`,
  `settings.changed`. Any number of consumers, including none.
- A **command** (`EEventKind.Command`) asks one owner to act, named `<noun>.<verb>.requested`:
  `settings.update.requested`. Exactly one durable consumer. It answers with an **outcome** fact
  (`settings.changed`) or `command.rejected` (`code` `invalid` or `failed`, an optional stable
  `errorCode`).
- Enum members are PascalCase (`EEventType.SettingsUpdateRequested`). A consumer name is the
  owner in kebab case (`settings`, `ai-auth`, `outbound`).
- Payloads are strict zod schemas of JSON-safe values: dates as epoch ms.
- `EVENT_SCRUBBED` types lose their payload once every delivery is done. Use it for secrets.

## Lanes and ordering

- A **lane** is one queue per consumer and event `key`. All subscriptions of one consumer share
  its lanes, so they run serially per key, in log order. Different keys and different consumers
  overlap.
- Keys: the canonical chat id (`signal:+100`), `scope|jobName` for a cron job, or `global`.
- A retry holds its lane during the backoff. Order wins over throughput.
- A follow-up keeps its cause's key unless `emit` or `request` passes one. Pass the chat id when
  the follow-up belongs on the chat's lane, as a notice from a cron or global event does.

## Delivery

- **Durable** subscriptions get a delivery row: at-least-once, retried per `backoffMs`
  (`backoffMs.length + 1` attempts), replayed on boot. **Live** ones are in memory only: caches,
  typing, closing sessions, anything that must not replay.
- Each boot costs a pending delivery one attempt, so a handler that kills the process ends dead.
  A command pending at boot is dead as `abandoned`: its requester is gone, and a repeated request
  revives it.
- A dead delivery appends `event.dead_lettered`; a dead command also appends `command.rejected`.
  Notices turns a dead fact into a chat notice, except for outbound types, dead letters and
  commands. `apps/assistant/scripts/redrive-events.ts` lists dead rows and sets chosen ones back
  to pending for the next boot.
- An effect outside the database is uncertain after a crash. Save a checkpoint fact with
  `ctx.transact` before it (`turn.started`, `cron.task.started`) and look for it with
  `ctx.findCaused` on redelivery, so a model run never repeats.

## Database rules

`DatabaseConnector.run` is one queue for the whole connection and is not re-entrant.

1. **A state change that causes a message**: `EventBus.instance.transact((tx, emit) => ...)`
   where `DatabaseConnector.instance.run` would go. Pass `tx` to store helpers, which take the
   handle as their first argument.
2. **A message with no state change**: `EventBus.instance.publish(draft)`, outside every run
   callback and transaction body. Inside one it deadlocks.
3. **Inside a handler**: `ctx.complete` or `ctx.transact`. Handlers run on lanes, outside any run
   callback.

Model, embedding, network, sandbox and `request` calls stay outside `transact` and `complete`.

## The bus API

```ts
bus.subscribe({
  consumer: "settings",
  type: EEventType.SettingsUpdateRequested,
  mode: ESubscriptionMode.Durable,
  backoffMs: [], // one attempt
  handler: async (event, ctx) => {
    // rows + follow-ups + the ack, in one transaction
    await ctx.complete(async (tx, emit) => {
      const record = await this.writeMany(tx, event.payload.ownerKey, event.payload.updates);
      // emit(type, payload, step, key)
      emit(EEventType.SettingsChanged, { ownerKey: event.payload.ownerKey, record }, undefined, undefined);
    });
  },
});
```

- `emit(type, payload, step, key)`: the follow-up inherits trace, `causationId` and a dedupe key
  `cause:consumer:type:step`, so a redelivery cannot publish it twice. Give each follow-up of one
  type its own `step` (a fan-out uses the chat id). `key` undefined keeps the cause's key.
- `ctx.complete`: rows, follow-ups and the ack commit together. A handler that returns without it
  is acked anyway.
- `ctx.transact`: rows and follow-ups without the ack, for a checkpoint.
- `ctx.request(type, payload, { outcome, step, key, timeoutMs })`: publish a command and await its
  outcome. Throws `CommandRejectedError` (with `code` and `errorCode`) or `CommandTimeoutError`
  (60 s default). Tools get it as `context.events`.
- `ctx.waitFor(causationId, type, timeoutMs)`: await a fact caused by an event already known, such
  as `cron.automation.detached` after an automation delete.
- A command handler that fails emits `command.rejected` with `commandFailed(event.type, error)`
  inside `ctx.complete`, so the requester fails at once.
- Outside a handler, `EventBus.instance.transact` gets `emit(draft)` with a whole `TEventDraft`.

## Waits

`request` and `waitFor` hold the caller's lane. The allowed waits form an acyclic graph, kept in
`ALLOWED_WAITS` in `events/boundaries.test.ts`:

- `conversation` → `cron`, `automations`, `settings`, `memory`, `calendar`, `ai-auth`
- `scheduling` → `automations`, `memory`
- `commands` → `mcp-auth`, `ai-auth`, `calendar`
- `ai-auth` → `settings`

A new wait is a new edge there; the test fails on a cycle.

## Direct calls that stay

A call across services is allowed only when it changes no state:

- Infrastructure: `DatabaseConnector`, `EventBus`, `AppLogger`, `startSpan`.
- Cached read models: `SettingsService.getAll` (fed by `settings.changed`),
  `AuthorizationService.listAuthorizedChatIds` (fed by `authorization.changed`).
- Drivers: `LlmClient`, `EmbeddingClient`, `aiModels`, the Discord and Signal clients, `gws`.
- The stateless engine: `AgentHarness.runMain`, `runScheduledTask`, `compactConversation`.
- Live state an event cannot carry: `McpService.open`, `McpRunRegistry`.
- Reads, including reads that prepare a command (`AutomationService.resolveNames`,
  `CronScheduler.get`), dry runs, status slash commands, and pure functions such as
  `parseCanonicalChatKey`.

Every other cross-service interaction is a message. The exact import list, with a reason per pair,
is `ALLOWED` in `events/boundaries.test.ts`.

Table owners: `memories`, `conversation_summaries` → Conversation · `facts`,
`fact_distillation_state` → Memory · `cron_engine_jobs` → Cron · `automations`,
`automation_drafts` → Automations · `user_configs` → Settings · `calendars` → Calendar ·
`message_authorizations` → Authorization · `events`, `event_deliveries` → EventBus.

## Adding a fact or command

1. **Catalog** (`events/catalog.ts`): add the `EEventType` member, an `S*` strict schema, and the
   entries in `TEventPayloads`, `EVENT_SCHEMAS` and `EVENT_KINDS`; add it to `EVENT_SCRUBBED` if
   it carries a secret. A command also gets its outcome fact.
2. **Consumer**: subscribe in the owning service's `setup()`. If the service is new, call its
   `setup()` in `src/index.ts` before `EventBus.instance.start()`, and add the same call to the
   registration in `events/boundaries.test.ts`.
3. **Producer**: emit it under the database rules, or `request` it from a handler or tool. A new
   wait adds its edge to `ALLOWED_WAITS`.
4. **Tests**: next to the handler, cover the outcome, each rejection code, and that rows and the
   ack commit together. Use `testEventRequester` or `withEventContext` from `events/test-utils.ts`
   for a handler context.
5. **Boundaries**: run `bun test --cwd apps/assistant src/services/events`. It checks that every
   command has exactly one durable consumer, that waits stay acyclic, and that cross-service
   imports are type-only, infrastructure, or in `ALLOWED`. A new pure-helper import goes into
   `ALLOWED` with its reason; a new write across services becomes a command instead.

Crash recovery is proven end to end by `src/index.test.ts`, which kills `src/fixtures/crash.ts`
at named points and boots it again.
