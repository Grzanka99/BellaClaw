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
- `EVENT_SCRUBBED` types lose their payload once no delivery is pending, so one that ends dead
  cannot be redriven. Use it for secrets.

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
  Notices turns a dead fact into a chat notice, except for outbound types, `message.sent`, dead
  letters, `conversation.changed` (the push), commands and the `conversation-title` consumer. `apps/assistant/scripts/redrive-events.ts` lists dead rows and sets chosen ones back
  to pending for the next boot.
- Boot deletes events older than 30 days whose deliveries are all done, with their delivery rows.
  Error text in `lastError` and `command.rejected` passes through `sanitizeErrorMessage`.
- An effect outside the database is uncertain after a crash. Save a checkpoint fact with
  `ctx.transact` before it (`turn.started`, `cron.task.started`), or after it with the result
  that a later commit applies (`conversation.summaries.fused`), and look for it with
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
- `ctx.lastAttempt`: a failure of this attempt ends the delivery dead. A handler that must never
  leave a dead letter, as the push, logs and returns instead of throwing then.
- A command handler that fails emits `command.rejected` with `commandFailed(event.type, error)`
  inside `ctx.complete`, so the requester fails at once.
- Outside a handler, `EventBus.instance.transact` gets `emit(draft)` with a whole `TEventDraft`.

## Waits

`request` and `waitFor` hold the caller's lane. The allowed waits form an acyclic graph, kept in
`ALLOWED_WAITS` in `events/boundaries.test.ts`:

- `conversation` → `cron`, `automations`, `settings`, `memory`, `calendar`, `ai-auth`, `identity`:
  a turn of an address held while the address or its account is being linked, on a hold lane of
  its own (`link-hold|<chat key>`), bounded from the hold, then forwarded to the account's lane
- `scheduling` → `automations`, `memory`, `identity`: a cron fire held while its address or its
  account is being linked, bounded from the fire's time like a held message
- `commands` → `mcp-auth`, `ai-auth`, `calendar`
- `ai-auth` → `settings`
- `authorization` → `identity`: a message held while its address or its account is being linked.
  It waits on Identity's read model (`waitWhileLinking`), bounded from the message's arrival
- `internal-api` → `settings`, `conversation`, `identity`, `app`. An HTTP request is on no lane: it publishes the
  command (a settings update, a message delete, a plain chat's create or delete, a link, a
  device's register or unregister) and awaits the outcome through live subscriptions. An app send publishes
  `message.received` (channel `app`, the client's message id as the dedupe key) and waits for
  nothing. Its stream (`/internal/stream`) forwards what `AppStream.listen` hears.

A new wait is a new edge there; the test fails on a cycle.

## Direct calls that stay

A call across services is allowed only when it changes no state:

- Infrastructure: `DatabaseConnector`, `EventBus`, `AppLogger`, `startSpan`.
- Cached read models: `SettingsService.getAll` (fed by `settings.changed`),
  `AuthorizationService.listAuthorizedChatIds` (fed by `authorization.changed`) and
  `matchesActivationToken` (the configured code, for the dashboard's registration),
  `IdentityService.resolve`, `linkedAccount`, `link`, `account`,
  `waitWhileLinking` and `listNoticeRecipients`
  (loaded from `identity_links`, fed by `identity.link.started` and `identity.linked`),
  `AppChannel.hasDevice`, `listDeviceIds` and `listDeviceAccounts` (loaded from `app_devices`, fed
  by `app.device.registered` and `app.device.unregistered`): Outbound reads which account has a
  device to pick the main channel, Notices adds those accounts to a global notice's audience, and
  the internal API lists an account's devices to unregister each.
- Drivers: `LlmClient`, `EmbeddingClient`, `aiModels`, the Discord and Signal clients, `gws`.
- The stateless engine: `AgentHarness.runMain`, `runPlain`, `runScheduledTask`,
  `compactConversation`.
- Live state an event cannot carry: `McpService.open`, `McpRunRegistry`, `AppStream.listen`
  (the dashboard's open streams), `AppChannel.openEdgeConnection`, `reportPresence` and
  `hasOpenStream` (which accounts have an open stream at the dashboard, in memory only).
- Bytes an event must not carry: the internal API hands an app upload to `AppChannel.store` and
  reads it back with `open`; `findAttachments` checks a send's named images.
- Reads, including reads that prepare a command (`AutomationService.resolveNames`,
  `CronScheduler.get`), `ConversationStore.findMessage` (the row a push carries), dry runs, status slash commands, and pure functions such as
  `parseCanonicalChatKey` and `IdentityService.accountIdOf`, `plainConversationKey` and
  `isPlainConversation`.

Every other cross-service interaction is a message. The exact import list, with a reason per pair,
is `ALLOWED` in `events/boundaries.test.ts`.

Conversation also owns the plain chats of the app: `conversation.create.requested` (an owner key)
lists a new one under the account, with a key Identity builds (`plain:<accountId>:<id>`), and
answers `conversation.created`; `conversation.delete.requested` on the chat's lane removes its
transcript, summary and registry entry and answers `conversation.deleted` (or `command.rejected`
with `conversation-not-found`). The delete emits `conversation.deleted`, which `app-stream` turns
into `deleted`. A turn or a reply that reaches a deleted plain chat's lane stores nothing.
`message.authorized` and the turn facts carry the conversation's `kind`, which Authorization sets:
Bella for a channel message, the registry's kind for an app message. A plain chat's message also carries the app's `model`
(provider, model, effort), which the internal API checks against the server's catalog and the
provider's API key or login, and the turn lays over the owner's settings; its persona is the
account's plain-chat setting (`ai.plainChats.*`), which AgentHarness adds to the plain agent's prompt, with Bella's persona resolved by `injectConfig` exactly as in the Bella prompt; a failed plain-chat
turn answers the failure reply without `ai.auth.diagnose`, which would switch the owner's provider; Commands passes its `!` messages to the turn, and Memory
neither distils its turns nor drains it at boot.

Conversation's durable consumer `conversation-title` takes each `turn.completed` of a listed plain chat
whose title is still null, on a lane of its own per chat key, so the call never holds the chat's next
turn: it reads that turn's message and reply, calls the account's Utility model outside any
transaction, and in one `ctx.complete` writes `conversations.title` and emits `conversation.changed`.
A deleted chat gets no row; a failed or empty answer is logged and acked, so it leaves no dead letter,
and the chat's next completed turn tries again. The backoff retries a database failure in reading the
exchange or storing the title; a crash redelivers at boot. A dead title delivery gets no notice: the
reply was already sent.

Table owners: `memories`, `conversation_summaries`, `conversations` → Conversation · `facts`,
`fact_distillation_state` → Memory · `cron_engine_jobs` → Cron · `automations`,
`automation_drafts` → Automations · `user_configs` → Settings · `calendars` → Calendar ·
`message_authorizations` → Authorization · `identity_links` → Identity · `app_media`,
`app_devices` → App channel ·
`events`, `event_deliveries` → EventBus.

Every change of a transcript (`memories`), and a plain chat's title, raises the conversation's
revision in `conversations` and emits `conversation.changed` with it and the owner key, in the same
transaction. A change that is not an append
(a delete, or rows moved in by a merge) also sets `rewriteRevision` to that revision, and the fact
carries it: a client synced at or above it fetches by cursor, below it reloads. A change that appended
the assistant row of a reply (a turn's last row), a delivery or a notice also carries that row's
`messageId`. Conversation writes the rows
of a sent reply, notice or delivery from `message.sent`; a reply with neither `transcript` nor
`display` is not stored, which keeps a confidential one out of history. Commands marks a
confidential reply with `confidential: true`.

The live consumer `app-stream` turns `conversation.changed`, `conversation.deleted` and
`turn.requested`, `turn.started`, `turn.completed`, `turn.failed` and `event.dead_lettered` of an
account's conversations into nudges, deletes and typing for the dashboard's one stream, tagged with the account id.
It turns a `reply.ready` marked `confidential` whose channel is the app into a `reply` with its text,
which the dashboard sends to that account's app sessions only: the only copy of the reply, lost
when no stream is open.
Typing goes on at `turn.requested` and again at `turn.started`, which carries the keys the turn
runs under: a turn queued behind another starts after that one's typing off. Nothing replays: the
app compares revisions on every connect. Its handlers do not await before sending, so a
conversation's events reach the stream in log order.

The app is a channel with nothing to send: Outbound reports `message.sent` at once, so the
transcript row is the delivery. A reply goes back to its origin. A delivery or notice has none and
goes to the main channel, decided at each attempt: the app while the account has a registered
device, else Identity's destination (the oldest active link, else the app; an unlinked chat's own
address).

The App channel owns the app's devices: its durable consumer `app` answers
`app.device.register.requested` with `app.device.registered` (insert or replace by the device id,
which the dashboard makes per app session) and `app.device.unregister.requested` with `app.device.unregistered`, or `command.rejected` with
`device-not-found` for a device the account does not hold; both on the `global` lane. The register
command carries the key material and is in `EVENT_SCRUBBED`. Its live consumer `app-cache` feeds
the device read model. Who owns a conversation is one rule, `findOwnedConversation` in
`@bellaclaw/database`: the registry's owner, or, before its first row, the account whose Bella
conversation it is. The dashboard's reads, the internal API's send and Authorization's gate for an
app message all use it.

The same consumer `app` pushes: on `conversation.changed` with a `messageId` whose row went out on
the `app` channel, for an account with no open stream, it encrypts the payload (`SAppPush`) for each
of the account's devices (RFC 8291, `app/web-push.ts`) and sends it to FCM HTTP v1 (`app/fcm.ts`),
outside any transaction, on the conversation's lane. A token FCM reports as unregistered becomes an
`app.device.unregister.requested` on `global`, emitted with `ctx.transact`, never requested. Any
other failure is retried per its backoff; on `ctx.lastAttempt` it is logged and acked. Without
`BELLACLAW_FCM_CREDENTIALS_PATH` (or its file) push is off and the change is acked.

## Adding a fact or command

1. **Catalog**: add the `EEventType` member in `packages/database/src/enums.ts`; in
   `events/catalog.ts` add an `S*` strict schema and the entries in `TEventPayloads`,
   `EVENT_SCHEMAS` and `EVENT_KINDS`; add it to `EVENT_SCRUBBED` if it carries a secret. A command
   also gets its outcome fact.
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
