import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  automationDraftsTable,
  automationsTable,
  calendarsTable,
  conversationSummariesTable,
  conversationsTable,
  cronEngineJobsTable,
  ECronJobStatus,
  ECronJobType,
  EEventType,
  EMBEDDING_DIMENSIONS,
  eventDeliveriesTable,
  eventsTable,
  factDistillationStateTable,
  factsTable,
  identityLinksTable,
  memoriesTable,
  userConfigsTable,
} from "@bellaclaw/database";
import { ADDRESS_LINKED_ELSEWHERE } from "@bellaclaw/shared";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { AgentHarness } from "../ai/agent-harness";
import { AuthorizationService } from "../authorization";
import { AutomationService } from "../automation";
import { EAutomationRunOutcome } from "../automation/runner";
import { CalendarService } from "../calendar";
import { Commands } from "../commands";
import { ConversationStore } from "../conversation";
import type { TConversation } from "../conversation/types";
import { CronScheduler } from "../cron";
import { DatabaseConnector } from "../database";
import { resetEventTables, resetIdentityLinksTable } from "../database/test-utils";
import { CommandRejectedError, ESubscriptionMode, EventBus, type TEventContext } from "../events";
import type { TEvent } from "../events/catalog";
import { testEventRequester, testMessageAddress, testMessageOrigin } from "../events/test-utils";
import { setupMcpAuth } from "../mcp/auth";
import { Memory } from "../memory";
import { FactDistiller } from "../memory/distill";
import type { TLiveFactWindow } from "../memory/types";
import { MessageHandler } from "../message-handler";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
import { Notices } from "../notices";
import { ScheduledDelivery } from "../scheduling/delivery";
import { SettingsService } from "../settings";
import { EConfigKey } from "../settings/schema";
import { IdentityService } from ".";
import { EIdentityLinkState } from "./schema";

const database = () => DatabaseConnector.instance.database;
const originalActivationToken = Bun.env.BELLACLAW_ACTIVATION_TOKEN;
const originalCredentialsPath = Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH;
let directory: string;
let credentialsPath: string;

function reset() {
  for (const service of [
    EventBus,
    IdentityService,
    AuthorizationService,
    Commands,
    MessageHandler,
    MessagingAdapter,
    Notices,
    SettingsService,
    CalendarService,
    AutomationService,
    Memory,
    FactDistiller,
    ScheduledDelivery,
  ]) {
    Object.assign(service, { _instance: undefined });
  }
  CronScheduler.instance.destroy();
}

async function resetOwnerTables() {
  for (const table of [
    "memories",
    "conversation_summaries",
    "conversations",
    "facts",
    "fact_distillation_state",
    "cron_engine_jobs",
    "automations",
    "automation_drafts",
    "user_configs",
    "calendars",
  ]) {
    await database().run(sql.raw(`DELETE FROM ${table}`));
  }
}

// drain: runs before each fact drain of a chat, whose distillation, a model call, finds no facts;
// false fails the drain
function setupOwners(drain: (conversationKey: string) => Promise<boolean>) {
  const drainLiveFactWindows = Reflect.get(FactDistiller.instance, "drainLiveFactWindows").bind(
    FactDistiller.instance,
  );
  Object.assign(FactDistiller.instance, {
    distill: async () => [],
    drainLiveFactWindows: async (conversationKey: string, ...rest: unknown[]) =>
      (await drain(conversationKey)) && drainLiveFactWindows(conversationKey, ...rest),
  });
  SettingsService.instance.setup();
  CronScheduler.instance.subscribe();
  AutomationService.instance.setup();
  Memory.instance.setup();
  FactDistiller.instance.setup();
  MessageHandler.instance.setup();
  setupMcpAuth();
  return Promise.all([IdentityService.instance.setup(), CalendarService.instance.setup()]);
}

function requestLink(accountId: string, address: string) {
  return testEventRequester.request(
    EEventType.IdentityLinkRequested,
    { accountId, channel: EMessagePlatform.Signal, address },
    { outcome: EEventType.IdentityLinkStarted, step: undefined, key: undefined, timeoutMs: 5_000 },
  );
}

async function transcript(chatId: string, at: number) {
  const row = await database()
    .insert(memoriesTable)
    .values({
      chatId,
      channel: "signal",
      author: "user",
      message: `${chatId} at ${at}`,
      createdAt: new Date(at),
    })
    .returning()
    .get();
  return row.id;
}

// a transcript message the model's context replays
async function replayed(chatId: string, kind: "user" | "assistant") {
  let message: Message = { role: "user", content: `${chatId} asks`, timestamp: Date.now() };
  if (kind === "assistant") {
    message = fauxAssistantMessage(`${chatId} answers`);
  }
  const row = await database()
    .insert(memoriesTable)
    .values({
      chatId,
      channel: "signal",
      author: kind,
      message: `${chatId} ${kind}`,
      modelMessage: JSON.stringify(message),
      createdAt: new Date(),
    })
    .returning()
    .get();
  return row.id;
}

async function summarize(chatId: string, summary: string, summarizedThroughId: number) {
  await database()
    .insert(conversationSummariesTable)
    .values({ chatId, summary, summarizedThroughId, createdAt: new Date(1) });
}

// the compaction engine, as the fusion of two summaries calls it: records each input, fails the
// first `failures` calls, then answers "fused <call>"
function stubFusion(failures: number) {
  const inputs: { summary: string; mark: number; entryIds: number[]; force: unknown }[] = [];
  const compactConversation = mock(async (state: TConversation, ...rest: unknown[]) => {
    inputs.push({
      summary: state.summary,
      mark: state.summarizedThroughId,
      entryIds: state.entries.map((entry) => entry.id),
      force: rest[6],
    });
    if (inputs.length <= failures) {
      throw new Error("The model is unavailable");
    }
    return {
      state: { ...state, summary: `fused ${inputs.length}`, summaryTimestamp: 5_000, entries: [] },
      usage: undefined,
      tokensBefore: 0,
      tokensAfter: 0,
    };
  });
  Object.assign(MessageHandler.instance, { ai: { compactConversation } });
  return inputs;
}

async function summaries() {
  return database()
    .select({
      chatId: conversationSummariesTable.chatId,
      summary: conversationSummariesTable.summary,
      summarizedThroughId: conversationSummariesTable.summarizedThroughId,
    })
    .from(conversationSummariesTable);
}

// one chat's rows in every owner's table; label tells the chats apart
async function seedChat(chatId: string, label: string) {
  const now = new Date();
  const sourceId = await transcript(chatId, now.getTime());
  await database()
    .insert(conversationSummariesTable)
    .values({ chatId, summary: `${label} summary`, summarizedThroughId: 0, createdAt: now });
  await database()
    .insert(factsTable)
    .values({
      chatId,
      text: `${label} fact`,
      embedding: new Array(EMBEDDING_DIMENSIONS).fill(0.1),
      createdAt: now,
      sourceMessageId: sourceId,
    });
  await database()
    .insert(factDistillationStateTable)
    .values({ chatId, lastProcessedMessageId: sourceId, updatedAt: now });
  await database().insert(userConfigsTable).values({
    ownerKey: chatId,
    key: EConfigKey.AiInstructionsTimezone,
    value: label,
    createdAt: now.getTime(),
    updatedAt: now.getTime(),
  });
  await database()
    .insert(calendarsTable)
    .values({ userId: chatId, calendarId: `${label}-calendar`, access: "write", addedAt: 1 });
  await database()
    .insert(cronEngineJobsTable)
    .values({
      name: "daily",
      scope: chatId,
      type: ECronJobType.OneTime,
      contentKind: "text",
      contentBody: `${label} reminder`,
      nextRunAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      createdAt: now,
    });
  await database().insert(automationsTable).values({
    scope: chatId,
    name: "weather",
    source: label,
    config: {},
    allowedOrigins: [],
    createdAt: now,
    updatedAt: now,
  });
  await database().insert(automationDraftsTable).values({
    scope: chatId,
    name: "draft",
    source: label,
    config: {},
    allowedOrigins: [],
    outputCapBytes: 1,
    createdAt: now,
  });
  const credentials = await Bun.file(credentialsPath).json();
  await Bun.write(
    credentialsPath,
    JSON.stringify({
      ...credentials,
      [`${encodeURIComponent(chatId)}:notes:${label}`]: { codeVerifier: label },
    }),
  );
}

// every row the owners hold under the key
async function rowsUnder(key: string) {
  const credentials = await Bun.file(credentialsPath).json();

  return [
    ...(await database().select().from(memoriesTable).where(eq(memoriesTable.chatId, key))),
    ...(await database()
      .select()
      .from(conversationSummariesTable)
      .where(eq(conversationSummariesTable.chatId, key))),
    ...(await database().select().from(factsTable).where(eq(factsTable.chatId, key))),
    ...(await database()
      .select()
      .from(factDistillationStateTable)
      .where(eq(factDistillationStateTable.chatId, key))),
    ...(await database().select().from(userConfigsTable).where(eq(userConfigsTable.ownerKey, key))),
    ...(await database().select().from(calendarsTable).where(eq(calendarsTable.userId, key))),
    ...(await database()
      .select()
      .from(cronEngineJobsTable)
      .where(eq(cronEngineJobsTable.scope, key))),
    ...(await database().select().from(automationsTable).where(eq(automationsTable.scope, key))),
    ...(await database()
      .select()
      .from(automationDraftsTable)
      .where(eq(automationDraftsTable.scope, key))),
    ...Object.keys(credentials).filter((name) => name.startsWith(`${encodeURIComponent(key)}:`)),
  ];
}

beforeEach(async () => {
  reset();
  await resetEventTables();
  await resetIdentityLinksTable();
  await resetOwnerTables();
  directory = await mkdtemp(join(tmpdir(), "bellaclaw-link-"));
  credentialsPath = join(directory, "mcp-credentials.json");
  Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH = credentialsPath;
  await Bun.write(credentialsPath, "{}");
});

afterEach(async () => {
  await EventBus.instance.idle();
  await EventBus.instance.stop();
  await resetIdentityLinksTable();
  await resetOwnerTables();
  reset();
  Bun.env.BELLACLAW_ACTIVATION_TOKEN = originalActivationToken;
  Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH = originalCredentialsPath;
  await rm(directory, { recursive: true, force: true });
});

describe("linking an address to an account", () => {
  test("into an empty account: every owner's rows move to the account, the link becomes active, and running the moves again changes nothing", async () => {
    await seedChat("signal:+900", "Europe/Warsaw");
    await database().insert(conversationsTable).values({
      conversationKey: "signal:+900",
      ownerKey: "signal:+900",
      revision: 4,
      rewriteRevision: 0,
    });
    const fusions = stubFusion(0);
    await setupOwners(async () => true);
    await EventBus.instance.start();

    const started = await requestLink("acct-9", "+900");
    await EventBus.instance.idle();

    // a plain re-key: no fusion, the address's summary is the conversation's
    expect(fusions).toEqual([]);
    expect(await summaries()).toEqual([
      { chatId: "bella:acct-9", summary: "Europe/Warsaw summary", summarizedThroughId: 0 },
    ]);

    expect(started.payload).toEqual({
      accountId: "acct-9",
      channel: EMessagePlatform.Signal,
      address: "+900",
      chatKey: "signal:+900",
      conversationKey: "bella:acct-9",
      ownerKey: "account:acct-9",
    });
    expect(await database().select().from(identityLinksTable)).toMatchObject([
      { address: "+900", accountId: "acct-9", state: EIdentityLinkState.Active },
    ]);
    expect(await rowsUnder("signal:+900")).toEqual([]);
    expect(await rowsUnder("bella:acct-9")).toHaveLength(3);
    expect(await rowsUnder("account:acct-9")).toHaveLength(7);
    expect(
      (await SettingsService.instance.getAll("account:acct-9"))[EConfigKey.AiInstructionsTimezone],
    ).toBe("Europe/Warsaw");
    // the merge is one change of the Bella conversation, which moves rows in, so it is also its
    // rewriteRevision; the address leaves the registry
    expect(await database().select().from(conversationsTable)).toMatchObject([
      {
        conversationKey: "bella:acct-9",
        ownerKey: "account:acct-9",
        revision: 1,
        rewriteRevision: 1,
      },
    ]);
    expect(
      (
        await database()
          .select()
          .from(eventsTable)
          .where(eq(eventsTable.type, EEventType.ConversationChanged))
      ).map((event) => event.payload),
    ).toEqual([
      {
        conversationKey: "bella:acct-9",
        ownerKey: "account:acct-9",
        revision: 1,
        rewriteRevision: 1,
      },
    ]);
    expect((await IdentityService.instance.resolve("signal:+900"))?.conversationKey).toBe(
      "bella:acct-9",
    );

    // every move delivered again, as the redrive script does after a restart
    const before = [await rowsUnder("bella:acct-9"), await rowsUnder("account:acct-9")];
    const moves = await database()
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(
        inArray(eventsTable.type, [
          EEventType.IdentityLinkStarted,
          EEventType.IdentityLinkSettled,
          EEventType.IdentityLinkQuiet,
          EEventType.IdentityLinkMoved,
        ]),
      );
    await database()
      .update(eventDeliveriesTable)
      .set({ status: "pending", attempts: 0 })
      .where(
        inArray(
          eventDeliveriesTable.eventSeq,
          moves.map((move) => move.seq),
        ),
      );
    await EventBus.instance.stop();
    reset();
    await setupOwners(async () => true);
    await EventBus.instance.start();
    await EventBus.instance.idle();

    expect([await rowsUnder("bella:acct-9"), await rowsUnder("account:acct-9")]).toEqual(before);
    expect(
      await database()
        .select()
        .from(eventsTable)
        .where(eq(eventsTable.type, EEventType.IdentityLinked)),
    ).toHaveLength(1);
  });

  test("an address with no transcript rows: the link completes, and the Bella conversation is listed with no change", async () => {
    await setupOwners(async () => true);
    await EventBus.instance.start();

    await requestLink("acct-13", "+980");
    await EventBus.instance.idle();

    expect(await database().select().from(identityLinksTable)).toMatchObject([
      { address: "+980", accountId: "acct-13", state: EIdentityLinkState.Active },
    ]);
    expect(await database().select().from(conversationsTable)).toMatchObject([
      {
        conversationKey: "bella:acct-13",
        ownerKey: "account:acct-13",
        revision: 0,
        rewriteRevision: 0,
      },
    ]);
    expect(
      await database()
        .select()
        .from(eventsTable)
        .where(eq(eventsTable.type, EEventType.ConversationChanged)),
    ).toEqual([]);
  });

  test("a notice in the Bella conversation before the first merge: the account owns it, and the merge raises its revision from there", async () => {
    await transcript("signal:+990", 1);
    const drained = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await setupOwners(async () => {
      drained.resolve();
      await release.promise;
      return true;
    });
    const changed = Promise.withResolvers<void>();
    EventBus.instance.subscribe({
      consumer: "test",
      type: EEventType.ConversationChanged,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: async () => {
        changed.resolve();
      },
    });
    await EventBus.instance.start();

    await requestLink("acct-14", "+990");
    await drained.promise;
    await EventBus.instance.publish({
      type: EEventType.MessageSent,
      source: "test",
      key: "bella:acct-14",
      trace: { turnId: "test:notice", chatId: "bella:acct-14", platform: undefined },
      payload: {
        chatId: "bella:acct-14",
        channel: EMessagePlatform.Signal,
        sourceType: EEventType.NoticeReady,
        chars: 6,
        sentAt: Date.now(),
        display: { text: "Notice" },
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    // the memory move still waits, so the link has not merged anything yet
    await changed.promise;

    expect(await database().select().from(conversationsTable)).toMatchObject([
      {
        conversationKey: "bella:acct-14",
        ownerKey: "account:acct-14",
        revision: 1,
        rewriteRevision: 0,
      },
    ]);

    release.resolve();
    await EventBus.instance.idle();

    expect(await database().select().from(conversationsTable)).toMatchObject([
      {
        conversationKey: "bella:acct-14",
        ownerKey: "account:acct-14",
        revision: 2,
        rewriteRevision: 2,
      },
    ]);
    expect(
      (
        await database()
          .select()
          .from(eventsTable)
          .where(eq(eventsTable.type, EEventType.ConversationChanged))
      ).map((event) => event.payload),
    ).toEqual([
      {
        conversationKey: "bella:acct-14",
        ownerKey: "account:acct-14",
        revision: 1,
        rewriteRevision: 0,
      },
      {
        conversationKey: "bella:acct-14",
        ownerKey: "account:acct-14",
        revision: 2,
        rewriteRevision: 2,
      },
    ]);
    expect(
      await database()
        .select({ kind: memoriesTable.kind })
        .from(memoriesTable)
        .where(eq(memoriesTable.chatId, "bella:acct-14"))
        .orderBy(asc(memoriesTable.id)),
    ).toEqual([{ kind: "message" }, { kind: "display" }]);
  });

  test("a second identity with its own data: one transcript in id order, the facts of both, clashing names renamed, the account's settings, calendars and credentials kept", async () => {
    await seedChat("signal:+910", "first");
    await seedChat("signal:+920", "second");
    // a pending edit of +920's "weather"
    await database().insert(automationDraftsTable).values({
      scope: "signal:+920",
      name: "weather",
      source: "second edit",
      config: {},
      allowedOrigins: [],
      outputCapBytes: 1,
      createdAt: new Date(),
    });
    const interleaved = [
      await transcript("signal:+910", 1),
      await transcript("signal:+920", 2),
      await transcript("signal:+910", 3),
      await transcript("signal:+920", 4),
    ];
    const fusions = stubFusion(0);
    await setupOwners(async () => true);
    await EventBus.instance.start();

    await requestLink("acct-10", "+910");
    await EventBus.instance.idle();
    await requestLink("acct-10", "+920");
    await EventBus.instance.idle();

    expect(await rowsUnder("signal:+910")).toEqual([]);
    expect(await rowsUnder("signal:+920")).toEqual([]);
    const rows = await database()
      .select({ id: memoriesTable.id })
      .from(memoriesTable)
      .where(eq(memoriesTable.chatId, "bella:acct-10"))
      .orderBy(asc(memoriesTable.id));
    expect(rows.map((row) => row.id).slice(-4)).toEqual(interleaved);
    expect(rows).toHaveLength(6);
    // two summaries become one; no row is replayable, so the fusion gets none
    expect(fusions).toEqual([
      { summary: "first summary\n\nsecond summary", mark: 0, entryIds: [], force: true },
    ]);
    expect(await summaries()).toEqual([
      { chatId: "bella:acct-10", summary: "fused 1", summarizedThroughId: 0 },
    ]);
    const facts = await database()
      .select({ text: factsTable.text })
      .from(factsTable)
      .where(eq(factsTable.chatId, "account:acct-10"))
      .orderBy(asc(factsTable.id));
    expect(facts.map((fact) => fact.text)).toEqual(["first fact", "second fact"]);
    const jobs = await database()
      .select({ name: cronEngineJobsTable.name, body: cronEngineJobsTable.contentBody })
      .from(cronEngineJobsTable)
      .where(eq(cronEngineJobsTable.status, ECronJobStatus.Active))
      .orderBy(asc(cronEngineJobsTable.id));
    expect(jobs).toEqual([
      { name: "daily", body: "first reminder" },
      { name: "daily (2)", body: "second reminder" },
    ]);
    const automations = await database()
      .select({ scope: automationsTable.scope, name: automationsTable.name })
      .from(automationsTable)
      .orderBy(asc(automationsTable.id));
    expect(automations).toEqual([
      { scope: "account:acct-10", name: "weather" },
      { scope: "account:acct-10", name: "weather (2)" },
    ]);
    // saving a draft never overwrites an automation it was not made for
    const drafts = await database()
      .select({ scope: automationDraftsTable.scope, name: automationDraftsTable.name })
      .from(automationDraftsTable)
      .orderBy(asc(automationDraftsTable.id));
    expect(drafts).toEqual([
      { scope: "account:acct-10", name: "draft" },
      { scope: "account:acct-10", name: "draft (2)" },
      { scope: "account:acct-10", name: "weather (2)" },
    ]);
    expect(
      await database()
        .select({ value: userConfigsTable.value })
        .from(userConfigsTable)
        .where(eq(userConfigsTable.ownerKey, "account:acct-10")),
    ).toEqual([{ value: "first" }]);
    expect(
      await database()
        .select({ calendarId: calendarsTable.calendarId })
        .from(calendarsTable)
        .where(eq(calendarsTable.userId, "account:acct-10")),
    ).toEqual([{ calendarId: "first-calendar" }]);
    expect(Object.keys(await Bun.file(credentialsPath).json())).toEqual([
      "account%3Aacct-10:notes:first",
    ]);
    expect(await database().select().from(conversationsTable)).toMatchObject([
      {
        conversationKey: "bella:acct-10",
        ownerKey: "account:acct-10",
        revision: expect.any(Number),
        rewriteRevision: expect.any(Number),
      },
    ]);
  });

  test("two chats with their own summaries and marks, rows interleaved: one fused summary, and the Bella conversation replays exactly the rows above its mark, from both, in id order", async () => {
    const b1 = await replayed("bella:acct-20", "user");
    const a1 = await replayed("signal:+200", "user");
    const a2 = await replayed("signal:+200", "assistant");
    const b2 = await replayed("bella:acct-20", "assistant");
    const b3 = await replayed("bella:acct-20", "user");
    const a3 = await replayed("signal:+200", "user");
    const b4 = await replayed("bella:acct-20", "assistant");
    const a4 = await replayed("signal:+200", "assistant");
    await summarize("bella:acct-20", "account summary", b2);
    await summarize("signal:+200", "address summary", a1);
    const fusions = stubFusion(0);
    await setupOwners(async () => true);
    await EventBus.instance.start();

    await requestLink("acct-20", "+200");
    await EventBus.instance.idle();

    expect(b1).toBeLessThan(a1);
    // the higher mark; a2, below it and not covered by the address's summary, is fused in
    expect(fusions).toEqual([
      { summary: "account summary\n\naddress summary", mark: b2, entryIds: [a2], force: true },
    ]);
    expect(await summaries()).toEqual([
      { chatId: "bella:acct-20", summary: "fused 1", summarizedThroughId: b2 },
    ]);
    const conversation = await ConversationStore.instance.load("bella:acct-20");
    expect(conversation?.summary).toBe("fused 1");
    expect(conversation?.entries.map((entry) => entry.id)).toEqual([b3, a3, b4, a4]);
    expect(await database().select().from(identityLinksTable)).toMatchObject([
      { address: "+200", state: EIdentityLinkState.Active },
    ]);
  });

  test("a summary on one side and rows only on the other: the rows a re-keyed summary would skip are fused in, the rest replayed", async () => {
    const a1 = await replayed("signal:+210", "user");
    const b1 = await replayed("bella:acct-21", "user");
    const a2 = await replayed("signal:+210", "assistant");
    const b2 = await replayed("bella:acct-21", "assistant");
    const a3 = await replayed("signal:+210", "user");
    await summarize("signal:+210", "address summary", a2);
    const fusions = stubFusion(0);
    await setupOwners(async () => true);
    await EventBus.instance.start();

    await requestLink("acct-21", "+210");
    await EventBus.instance.idle();

    expect(a1).toBeLessThan(b1);
    expect(fusions).toEqual([
      { summary: "address summary", mark: a2, entryIds: [b1], force: true },
    ]);
    const conversation = await ConversationStore.instance.load("bella:acct-21");
    expect(conversation?.summary).toBe("fused 1");
    expect(conversation?.summarizedThroughId).toBe(a2);
    expect(conversation?.entries.map((entry) => entry.id)).toEqual([b2, a3]);
    expect(await summaries()).toHaveLength(1);
  });

  test("both chats with undistilled rows: one checkpoint after the link, every row distilled once, and a further drain distills nothing again", async () => {
    const a1 = await transcript("signal:+220", 1);
    const b1 = await transcript("bella:acct-22", 2);
    const b2 = await transcript("bella:acct-22", 3);
    const a2 = await transcript("signal:+220", 4);
    await setupOwners(async () => true);
    const windows: number[][] = [];
    Object.assign(FactDistiller.instance, {
      distill: async (window: TLiveFactWindow) => {
        windows.push(window.messages.map((message) => message.id));
        return [];
      },
    });
    await EventBus.instance.start();

    await requestLink("acct-22", "+220");
    await EventBus.instance.idle();

    expect(windows).toEqual([
      [a1, a2],
      [b1, b2],
    ]);
    expect(
      await database()
        .select({
          chatId: factDistillationStateTable.chatId,
          through: factDistillationStateTable.lastProcessedMessageId,
        })
        .from(factDistillationStateTable),
    ).toEqual([{ chatId: "bella:acct-22", through: a2 }]);

    const later = await transcript("bella:acct-22", 5);
    const drain = Reflect.get(FactDistiller.instance, "drainLiveFactWindows");
    expect(
      await drain(
        "bella:acct-22",
        "account:acct-22",
        await SettingsService.instance.getAll("account:acct-22"),
        { turnId: "test:drain", chatId: "bella:acct-22", platform: undefined },
      ),
    ).toBe(true);
    expect(windows.slice(2)).toEqual([[later]]);
  });

  test("a fusion that fails once: the move retries, and the link becomes active with one summary", async () => {
    await summarize("signal:+240", "address summary", 0);
    await summarize("bella:acct-24", "account summary", 0);
    const fusions = stubFusion(1);
    await setupOwners(async () => true);
    await EventBus.instance.start();

    await requestLink("acct-24", "+240");
    await EventBus.instance.idle();

    expect(fusions).toHaveLength(2);
    expect(await summaries()).toEqual([
      { chatId: "bella:acct-24", summary: "fused 2", summarizedThroughId: 0 },
    ]);
    expect(await database().select().from(identityLinksTable)).toMatchObject([
      { address: "+240", state: EIdentityLinkState.Active },
    ]);
  });

  test("a fact drain that fails once: the move waits for its retry, and the link becomes active with the address's facts", async () => {
    await seedChat("signal:+915", "retried");
    let drains = 0;
    await setupOwners(async () => {
      drains += 1;
      return drains > 1;
    });
    await EventBus.instance.start();

    await requestLink("acct-15", "+915");
    await EventBus.instance.idle();

    // the address's drain failed and retried, then the account's
    expect(drains).toBe(3);
    expect(await database().select().from(identityLinksTable)).toMatchObject([
      { address: "+915", state: EIdentityLinkState.Active },
    ]);
    expect(
      await database()
        .select({ text: factsTable.text })
        .from(factsTable)
        .where(eq(factsTable.chatId, "account:acct-15")),
    ).toEqual([{ text: "retried fact" }]);
    expect(await rowsUnder("signal:+915")).toEqual([]);
  });

  test("a turn held open across the start of a link: the setting and the cron job it saves after the start end under the account's owner key", async () => {
    const running = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runMain = mock(async (args: Parameters<AgentHarness["runMain"]>[0]) => {
      running.resolve();
      await release.promise;
      await args.events.request(
        EEventType.SettingsUpdateRequested,
        {
          ownerKey: "signal:+970",
          updates: [{ key: EConfigKey.AiInstructionsTimezone, value: "Europe/Paris" }],
        },
        { outcome: EEventType.SettingsChanged, step: "setting", key: undefined, timeoutMs: 5_000 },
      );
      await args.events.request(
        EEventType.CronJobScheduleRequested,
        {
          name: "water",
          scope: "signal:+970",
          content: { kind: "text", text: "Drink water" },
          automationIds: [],
          fireAt: Date.now() + 24 * 60 * 60 * 1000,
        },
        { outcome: EEventType.CronJobScheduled, step: "cron", key: undefined, timeoutMs: 5_000 },
      );
      const messages: Message[] = [
        { role: "user", content: args.prompt, timestamp: Date.now() },
        fauxAssistantMessage("Done"),
      ];
      return { text: "Done", iterations: 1, toolCallCount: 2, stopReason: "completed", messages };
    });
    Object.assign(MessageHandler.instance, {
      ai: { runMain, compactConversation: mock(async () => undefined) },
    });
    await setupOwners(async () => true);
    await EventBus.instance.start();

    await EventBus.instance.publish({
      type: EEventType.TurnRequested,
      source: "test",
      key: "signal:+970",
      trace: { turnId: "test:held-turn", chatId: "signal:+970", platform: undefined },
      payload: {
        ...testMessageOrigin("signal:+970", EMessagePlatform.Signal),
        content: "Remind me to drink water",
        attachments: [],
        receivedAt: Date.now(),
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    await running.promise;
    await requestLink("acct-13", "+970");
    release.resolve();
    await EventBus.instance.idle();

    expect(await database().select().from(identityLinksTable)).toMatchObject([
      { address: "+970", state: EIdentityLinkState.Active },
    ]);
    expect(await rowsUnder("signal:+970")).toEqual([]);
    expect(
      await database()
        .select({ value: userConfigsTable.value })
        .from(userConfigsTable)
        .where(eq(userConfigsTable.ownerKey, "account:acct-13")),
    ).toEqual([{ value: "Europe/Paris" }]);
    expect(
      await database()
        .select({ name: cronEngineJobsTable.name })
        .from(cronEngineJobsTable)
        .where(eq(cronEngineJobsTable.scope, "account:acct-13")),
    ).toEqual([{ name: "water" }]);
  });

  test("a cron fire of the address's automation job during the link runs after it, once, with the account's automation, into the Bella conversation", async () => {
    await seedChat("signal:+980", "fired");
    const [automation] = await database()
      .select({ id: automationsTable.id })
      .from(automationsTable)
      .where(eq(automationsTable.scope, "signal:+980"));
    const drained = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const drain = mock(async () => {
      drained.resolve();
      await release.promise;
      return true;
    });
    const run = mock(
      async (_event: TEvent<EEventType.AutomationRunRequested>, ctx: TEventContext) => {
        await ctx.complete(async (_tx, emit) => {
          emit(
            EEventType.AutomationRunCompleted,
            {
              report: {
                name: "weather",
                outcome: EAutomationRunOutcome.Text,
                text: "Sunny",
                data: undefined,
                fetches: [],
                logs: [],
                durationMs: 1,
                paused: false,
              },
            },
            undefined,
            undefined,
          );
        });
      },
    );
    Object.assign(AutomationService.instance, { handleRunRequested: run });
    ScheduledDelivery.instance.setup();
    await setupOwners(drain);
    await EventBus.instance.start();

    await requestLink("acct-14", "+980");
    await drained.promise;
    await EventBus.instance.publish({
      type: EEventType.CronFired,
      source: "test",
      key: "signal:+980|weather",
      trace: { turnId: "test:cron", chatId: "signal:+980", platform: undefined },
      payload: {
        jobId: 1,
        name: "weather",
        scope: "signal:+980",
        jobType: ECronJobType.OneTime,
        content: { kind: "automations" },
        automationIds: [automation?.id ?? 0],
        nextRunAt: Date.now(),
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    await Bun.sleep(50);
    const runsWhileHeld = run.mock.calls.length;
    release.resolve();
    await EventBus.instance.idle();

    expect(runsWhileHeld).toBe(0);
    expect(run.mock.calls.map(([event]) => event.payload.scope)).toEqual(["account:acct-14"]);
    const deliveries = await database()
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.DeliveryReady));
    expect(deliveries).toMatchObject([{ payload: { chatId: "bella:acct-14", text: "Sunny" } }]);
  });

  test("an address of another account is rejected with a stable code and nothing moves", async () => {
    await database()
      .insert(identityLinksTable)
      .values({
        channel: EMessagePlatform.Signal,
        address: "+930",
        accountId: "acct-owner",
        state: EIdentityLinkState.Active,
        linkedAt: new Date(1_000),
      });
    await seedChat("signal:+930", "owned");
    await setupOwners(async () => true);
    await EventBus.instance.start();

    const rejected = await requestLink("acct-other", "+930").catch((error) => error);
    await EventBus.instance.idle();

    expect(rejected).toBeInstanceOf(CommandRejectedError);
    expect(rejected.errorCode).toBe(ADDRESS_LINKED_ELSEWHERE);
    expect(await database().select().from(identityLinksTable)).toMatchObject([
      { address: "+930", accountId: "acct-owner" },
    ]);
    expect(await rowsUnder("signal:+930")).toHaveLength(10);
    expect(
      await database()
        .select()
        .from(eventsTable)
        .where(eq(eventsTable.type, EEventType.IdentityLinkStarted)),
    ).toEqual([]);
  });

  test("a repeated request while the link is migrating is rejected and starts no second cutover", async () => {
    await seedChat("signal:+935", "repeated");
    const drained = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const drain = mock(async (_conversationKey: string) => {
      drained.resolve();
      await release.promise;
      return true;
    });
    await setupOwners(drain);
    await EventBus.instance.start();

    await requestLink("acct-935", "+935");
    await drained.promise;
    const rejected = await requestLink("acct-935", "+935").catch((error) => error);
    release.resolve();
    await EventBus.instance.idle();

    expect(rejected).toBeInstanceOf(CommandRejectedError);
    // one cutover: both transcripts' drains before the join
    expect(drain.mock.calls).toEqual([["signal:+935"], ["bella:acct-935"]]);
    for (const type of [EEventType.IdentityLinkStarted, EEventType.IdentityLinked]) {
      expect(
        await database().select().from(eventsTable).where(eq(eventsTable.type, type)),
      ).toHaveLength(1);
    }
    expect(await database().select().from(identityLinksTable)).toMatchObject([
      { address: "+935", state: EIdentityLinkState.Active },
    ]);
    expect(await rowsUnder("signal:+935")).toEqual([]);
  });

  test("a turn of the address requested after the barrier is answered once, after activation, in the Bella conversation, and the cron job it saves is the account's", async () => {
    const drained = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const drain = mock(async () => {
      drained.resolve();
      await release.promise;
      return true;
    });
    const statesAtRun: string[] = [];
    const runMain = mock(async (args: Parameters<AgentHarness["runMain"]>[0]) => {
      const [link] = await database().select().from(identityLinksTable);
      statesAtRun.push(link?.state ?? "none");
      await args.events.request(
        EEventType.CronJobScheduleRequested,
        {
          name: "water",
          scope: args.ownerKey ?? "no owner",
          content: { kind: "text", text: "Drink water" },
          automationIds: [],
          fireAt: Date.now() + 24 * 60 * 60 * 1000,
        },
        { outcome: EEventType.CronJobScheduled, step: "cron", key: undefined, timeoutMs: 5_000 },
      );
      const messages: Message[] = [
        { role: "user", content: args.prompt, timestamp: Date.now() },
        fauxAssistantMessage("Done"),
      ];
      return { text: "Done", iterations: 1, toolCallCount: 1, stopReason: "completed", messages };
    });
    Object.assign(MessageHandler.instance, {
      ai: { runMain, compactConversation: mock(async () => undefined) },
    });
    await setupOwners(drain);
    await EventBus.instance.start();

    await requestLink("acct-975", "+975");
    await drained.promise;
    // authorized before the link started, so stamped with the address's keys
    await EventBus.instance.publish({
      type: EEventType.TurnRequested,
      source: "test",
      key: "signal:+975",
      trace: { turnId: "test:late-turn", chatId: "signal:+975", platform: undefined },
      payload: {
        ...testMessageOrigin("signal:+975", EMessagePlatform.Signal),
        content: "Remind me to drink water",
        attachments: [],
        receivedAt: Date.now(),
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    await Bun.sleep(50);
    const callsWhileHeld = runMain.mock.calls.length;
    release.resolve();
    await EventBus.instance.idle();

    expect(callsWhileHeld).toBe(0);

    expect(runMain.mock.calls.map(([args]) => [args.conversationKey, args.ownerKey])).toEqual([
      ["bella:acct-975", "account:acct-975"],
    ]);
    expect(statesAtRun).toEqual([EIdentityLinkState.Active]);
    expect(
      await database()
        .select({ scope: cronEngineJobsTable.scope, name: cronEngineJobsTable.name })
        .from(cronEngineJobsTable),
    ).toEqual([{ scope: "account:acct-975", name: "water" }]);
    expect(await rowsUnder("signal:+975")).toEqual([]);
    // the turn's two rows and the checkpoint of its fact drain
    expect(await rowsUnder("bella:acct-975")).toHaveLength(3);
  });

  test("a turn of a linked address interrupted by a restart: its interrupted reply and failure carry the account's keys", async () => {
    await database()
      .insert(identityLinksTable)
      .values({
        channel: EMessagePlatform.Signal,
        address: "+980",
        accountId: "acct-980",
        state: EIdentityLinkState.Active,
        linkedAt: new Date(1_000),
      });
    const running = Promise.withResolvers<void>();
    const stalled = mock(() => {
      running.resolve();
      return new Promise(() => undefined);
    });
    Object.assign(MessageHandler.instance, {
      ai: { runMain: stalled, compactConversation: mock(async () => undefined) },
    });
    await setupOwners(async () => true);
    await EventBus.instance.start();
    await EventBus.instance.publish({
      type: EEventType.TurnRequested,
      source: "test",
      key: "signal:+980",
      trace: { turnId: "test:interrupted-turn", chatId: "signal:+980", platform: undefined },
      payload: {
        ...testMessageOrigin("signal:+980", EMessagePlatform.Signal),
        content: "Book the flight",
        attachments: [],
        receivedAt: Date.now(),
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    await running.promise;

    // restart: the stalled attempt dies with the old bus and handler
    await EventBus.instance.stop();
    reset();
    const runMain = mock(async () => {
      throw new Error("The interrupted turn ran again");
    });
    Object.assign(MessageHandler.instance, {
      ai: { runMain, compactConversation: mock(async () => undefined) },
    });
    await setupOwners(async () => true);
    await EventBus.instance.start();
    await EventBus.instance.idle();

    expect(runMain).not.toHaveBeenCalled();
    const account = { conversationKey: "bella:acct-980", ownerKey: "account:acct-980" };

    for (const type of [EEventType.ReplyReady, EEventType.TurnFailed]) {
      const rows = await database().select().from(eventsTable).where(eq(eventsTable.type, type));
      expect(rows.map((row) => row.payload)).toMatchObject([account]);
    }
  });

  test("a message sent during the link is answered after it, once, in the account's Bella conversation on Signal; so is one sent after it", async () => {
    await transcript("signal:+940", 1);
    const drained = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const drain = mock(async () => {
      drained.resolve();
      await release.promise;
      return true;
    });
    const runMain = mock(async (args: Parameters<AgentHarness["runMain"]>[0]) => {
      const text = `Reply to ${args.prompt}`;
      const messages: Message[] = [
        ...(args.conversation?.entries.map((entry) => entry.message) ?? []),
        { role: "user", content: args.prompt, timestamp: Date.now() },
        fauxAssistantMessage(text),
      ];
      return { text, iterations: 1, toolCallCount: 0, stopReason: "completed", messages };
    });
    Object.assign(MessageHandler.instance, {
      ai: { runMain, compactConversation: mock(async () => undefined) },
    });
    const sendText = mock(async (_address: string, _text: string) => undefined);
    MessagingAdapter.instance.registerTransport({
      platform: EMessagePlatform.Signal,
      sendText,
      fetchAttachment: async () => new Uint8Array(),
      deleteAttachment: async () => undefined,
    });
    delete Bun.env.BELLACLAW_ACTIVATION_TOKEN;
    await setupOwners(drain);
    await AuthorizationService.instance.setup();
    Commands.instance.setup();
    MessagingAdapter.instance.setup();
    await EventBus.instance.start();
    const receive = (content: string) =>
      EventBus.instance.publish({
        type: EEventType.MessageReceived,
        source: "test",
        key: "signal:+940",
        trace: { turnId: `test:${content}`, chatId: "signal:+940", platform: undefined },
        payload: {
          ...testMessageAddress("signal:+940", EMessagePlatform.Signal),
          content,
          attachments: [],
          receivedAt: Date.now(),
        },
        causationId: undefined,
        dedupeKey: undefined,
      });

    await requestLink("acct-11", "+940");
    await drained.promise;
    await receive("During");
    release.resolve();
    await EventBus.instance.idle();
    await receive("After");
    await EventBus.instance.idle();

    expect(runMain.mock.calls.map(([args]) => [args.prompt, args.conversationKey])).toEqual([
      ["During", "bella:acct-11"],
      ["After", "bella:acct-11"],
    ]);
    expect(sendText.mock.calls).toEqual([
      ["+940", "Reply to During"],
      ["+940", "Reply to After"],
    ]);
    expect(
      await database()
        .select({ channel: memoriesTable.channel })
        .from(memoriesTable)
        .where(eq(memoriesTable.chatId, "bella:acct-11")),
    ).toHaveLength(5);
    expect(await rowsUnder("signal:+940")).toEqual([]);
  });

  test("an old-key message.sent while the link is migrating is stored under the address until its rows move, in the Bella conversation after", async () => {
    for (const address of ["+960", "+961"]) {
      await database()
        .insert(identityLinksTable)
        .values({
          channel: EMessagePlatform.Signal,
          address,
          accountId: `acct-${address}`,
          state: EIdentityLinkState.Migrating,
          linkedAt: new Date(1_000),
        });
    }
    // +960's rows still wait to be moved; +961's moved already
    await transcript("signal:+960", 1);
    MessageHandler.instance.setup();
    await EventBus.instance.start();

    for (const chatId of ["signal:+960", "signal:+961"]) {
      await EventBus.instance.publish({
        type: EEventType.MessageSent,
        source: "test",
        key: chatId,
        trace: { turnId: `test:${chatId}`, chatId, platform: undefined },
        payload: {
          chatId,
          channel: EMessagePlatform.Signal,
          sourceType: EEventType.DeliveryReady,
          chars: 5,
          sentAt: Date.now(),
          transcript: { text: "Reminder", notice: "notice" },
        },
        causationId: undefined,
        dedupeKey: undefined,
      });
    }
    await EventBus.instance.idle();

    expect(await rowsUnder("signal:+960")).toHaveLength(3);
    expect(await rowsUnder("signal:+961")).toEqual([]);
    expect(await rowsUnder("bella:acct-+961")).toHaveLength(2);
  });

  test("a message held longer than the bound ends as a dead letter with the usual notice", async () => {
    await database()
      .insert(identityLinksTable)
      .values({
        channel: EMessagePlatform.Signal,
        address: "+950",
        accountId: "acct-12",
        state: EIdentityLinkState.Migrating,
        linkedAt: new Date(1_000),
      });
    const sendText = mock(async (_address: string, _text: string) => undefined);
    MessagingAdapter.instance.registerTransport({
      platform: EMessagePlatform.Signal,
      sendText,
      fetchAttachment: async () => new Uint8Array(),
      deleteAttachment: async () => undefined,
    });
    delete Bun.env.BELLACLAW_ACTIVATION_TOKEN;
    Object.assign(IdentityService.instance, { linkHoldMs: 50 });
    await AuthorizationService.instance.setup();
    MessagingAdapter.instance.setup();
    Notices.instance.setup();
    await EventBus.instance.start();

    await EventBus.instance.publish({
      type: EEventType.MessageReceived,
      source: "test",
      key: "signal:+950",
      trace: { turnId: "test:held", chatId: "signal:+950", platform: undefined },
      payload: {
        ...testMessageAddress("signal:+950", EMessagePlatform.Signal),
        content: "Hello",
        attachments: [],
        receivedAt: Date.now(),
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    await EventBus.instance.idle();

    expect(
      await database()
        .select({ consumer: eventDeliveriesTable.consumer, status: eventDeliveriesTable.status })
        .from(eventDeliveriesTable)
        .innerJoin(eventsTable, eq(eventsTable.seq, eventDeliveriesTable.eventSeq))
        .where(eq(eventsTable.type, EEventType.MessageReceived)),
    ).toEqual([{ consumer: "authorization", status: "dead" }]);
    expect(
      await database()
        .select()
        .from(eventsTable)
        .where(eq(eventsTable.type, EEventType.MessageAuthorized)),
    ).toEqual([]);
    expect(sendText.mock.calls).toEqual([
      ["+950", "Something I was doing failed and was dropped. Try again."],
    ]);
  }, 20_000);
});
