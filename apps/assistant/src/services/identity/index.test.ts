import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  ECronJobType,
  EEventType,
  eventDeliveriesTable,
  eventsTable,
  identityLinksTable,
  memoriesTable,
  messageAuthorizationsTable,
} from "@bellaclaw/database";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { asc, eq } from "drizzle-orm";
import type { AgentHarness } from "../ai/agent-harness";
import { AuthorizationService } from "../authorization";
import { EAuthorizationStatus } from "../authorization/schema";
import { Commands } from "../commands";
import { DatabaseConnector } from "../database";
import {
  resetEventTables,
  resetIdentityLinksTable,
  resetMessageAuthorizationsTable,
} from "../database/test-utils";
import { EventBus } from "../events";
import { testMessageOrigin } from "../events/test-utils";
import { MessageHandler } from "../message-handler";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
import { Notices } from "../notices";
import { ScheduledDelivery } from "../scheduling/delivery";
import { SettingsService } from "../settings";
import { DefaultConfigRecord } from "../settings/schema";
import { IdentityService } from ".";
import { EIdentityLinkState } from "./schema";

const originalActivationToken = Bun.env.BELLACLAW_ACTIVATION_TOKEN;

function reset() {
  Object.assign(EventBus, { _instance: undefined });
  Object.assign(IdentityService, { _instance: undefined });
  Object.assign(AuthorizationService, { _instance: undefined });
  Object.assign(Commands, { _instance: undefined });
  Object.assign(MessageHandler, { _instance: undefined });
  Object.assign(MessagingAdapter, { _instance: undefined });
  Object.assign(Notices, { _instance: undefined });
  Object.assign(ScheduledDelivery, { _instance: undefined });
  Object.assign(SettingsService, { _instance: undefined });
}

function link(
  channel: EMessagePlatform,
  address: string,
  accountId: string,
  linkedAt: number,
  state = EIdentityLinkState.Active,
) {
  return DatabaseConnector.instance.database
    .insert(identityLinksTable)
    .values({ channel, address, accountId, state, linkedAt: new Date(linkedAt) });
}

function transport(platform: EMessagePlatform) {
  const sendText = mock(async (_address: string, _text: string) => undefined);
  MessagingAdapter.instance.registerTransport({
    platform,
    sendText,
    fetchAttachment: async () => new Uint8Array(),
    deleteAttachment: async () => undefined,
  });
  return sendText;
}

function mockSettings() {
  const getAll = mock(async (_ownerKey: string) => DefaultConfigRecord);
  Object.assign(SettingsService, { _instance: { getAll } });
  return getAll;
}

async function rows(chatId: string) {
  return DatabaseConnector.instance.database
    .select({ author: memoriesTable.author, channel: memoriesTable.channel })
    .from(memoriesTable)
    .where(eq(memoriesTable.chatId, chatId))
    .orderBy(asc(memoriesTable.id));
}

async function eventsOf(type: EEventType) {
  return DatabaseConnector.instance.database
    .select({ key: eventsTable.key, payload: eventsTable.payload })
    .from(eventsTable)
    .where(eq(eventsTable.type, type))
    .orderBy(asc(eventsTable.seq));
}

beforeEach(async () => {
  reset();
  await resetEventTables();
  await resetIdentityLinksTable();
});

afterEach(async () => {
  await EventBus.instance.idle();
  await EventBus.instance.stop();
  await resetIdentityLinksTable();
  reset();
  Bun.env.BELLACLAW_ACTIVATION_TOKEN = originalActivationToken;
});

describe("IdentityService", () => {
  test("a message from a linked Signal address runs its turn in the account's Bella conversation and is answered on Signal", async () => {
    Bun.env.BELLACLAW_ACTIVATION_TOKEN = "open-sesame";
    await resetMessageAuthorizationsTable();
    await DatabaseConnector.instance.database.insert(messageAuthorizationsTable).values([
      { chatId: "signal:+100", status: EAuthorizationStatus.Authorized, failedAttempts: 0 },
      { chatId: "signal:+200", status: EAuthorizationStatus.Authorized, failedAttempts: 0 },
    ]);
    await link(EMessagePlatform.Signal, "+100", "acct-1", 1_000);
    await link(EMessagePlatform.Signal, "+200", "acct-1", 2_000);
    const getAll = mockSettings();
    const runMain = mock(async (args: Parameters<AgentHarness["runMain"]>[0]) => {
      const messages: Message[] = [
        { role: "user", content: args.prompt, timestamp: Date.now() },
        fauxAssistantMessage("Main reply"),
      ];
      return {
        text: "Main reply",
        iterations: 1,
        toolCallCount: 0,
        stopReason: "completed",
        messages,
      };
    });
    Object.assign(MessageHandler.instance, {
      ai: { runMain, compactConversation: mock(async () => undefined) },
    });
    const sendText = transport(EMessagePlatform.Signal);
    await AuthorizationService.instance.setup();
    Commands.instance.setup();
    MessageHandler.instance.setup();
    MessagingAdapter.instance.setup();
    await EventBus.instance.start();

    await EventBus.instance.publish({
      type: EEventType.MessageReceived,
      source: "test",
      key: "signal:+200",
      trace: { turnId: "test:linked", chatId: "signal:+200", platform: EMessagePlatform.Signal },
      payload: {
        ...testMessageOrigin("signal:+200", EMessagePlatform.Signal),
        content: "Hello",
        attachments: [],
        receivedAt: Date.now(),
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    await EventBus.instance.idle();

    expect(await rows("bella:acct-1")).toEqual([
      { author: "user", channel: EMessagePlatform.Signal },
      { author: "assistant", channel: EMessagePlatform.Signal },
    ]);
    expect(await rows("signal:+200")).toEqual([]);
    expect((await eventsOf(EEventType.TurnRequested)).map((row) => row.key)).toEqual([
      "bella:acct-1",
    ]);
    expect(getAll).toHaveBeenCalledWith("account:acct-1");
    expect(runMain.mock.calls[0]?.[0]).toMatchObject({
      conversationKey: "bella:acct-1",
      ownerKey: "account:acct-1",
    });
    // the reply goes back to the address it was asked from, not the identity linked first
    expect(sendText.mock.calls).toEqual([["+200", "Main reply"]]);
  });

  test("a cron job of an account runs in its Bella conversation and sends one message, to the identity linked first, formatted for its channel", async () => {
    await link(EMessagePlatform.Signal, "+300", "acct-2", 2_000);
    await link(EMessagePlatform.Discord, "user-1", "acct-2", 1_000);
    mockSettings();
    const discord = transport(EMessagePlatform.Discord);
    const signal = transport(EMessagePlatform.Signal);
    const runScheduledTask = mock(
      async (_args: { platform: EMessagePlatform; conversationKey: string; ownerKey: string }) => ({
        text: "Your briefing.",
        stopReason: "completed",
        iterations: 1,
        toolCallCount: 0,
      }),
    );
    Object.assign(ScheduledDelivery.instance, { ai: { runScheduledTask } });
    ScheduledDelivery.instance.setup();
    MessagingAdapter.instance.setup();
    MessageHandler.instance.setup();
    await EventBus.instance.start();

    await EventBus.instance.publish({
      type: EEventType.CronFired,
      source: "test",
      key: "account:acct-2|briefing",
      trace: { turnId: "test:cron", chatId: undefined, platform: undefined },
      payload: {
        jobId: 1,
        name: "briefing",
        scope: "account:acct-2",
        jobType: ECronJobType.OneTime,
        content: { kind: "task", prompt: "Prepare a briefing", fallback: "Failed" },
        automationIds: [],
        nextRunAt: Date.now(),
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    await EventBus.instance.idle();

    expect(runScheduledTask.mock.calls[0]?.[0]).toMatchObject({
      platform: EMessagePlatform.Discord,
      conversationKey: "bella:acct-2",
      ownerKey: "account:acct-2",
    });
    expect(discord.mock.calls).toEqual([["user-1", "Your briefing."]]);
    expect(signal).not.toHaveBeenCalled();
    expect((await eventsOf(EEventType.DeliveryReady)).map((row) => row.key)).toEqual([
      "bella:acct-2",
    ]);
    // the scheduler notice and the delivered text
    expect(await rows("bella:acct-2")).toEqual([
      { author: "user", channel: EMessagePlatform.Discord },
      { author: "assistant", channel: EMessagePlatform.Discord },
    ]);
  });

  test("a global notice reaches an account with two identities once and every unlinked authorized chat", async () => {
    await link(EMessagePlatform.Signal, "+400", "acct-3", 1_000);
    await link(EMessagePlatform.Signal, "+401", "acct-3", 2_000);
    const authorized = spyOn(
      AuthorizationService.instance,
      "listAuthorizedChatIds",
    ).mockResolvedValue(["signal:+400", "signal:+401", "signal:+500"]);
    const sendText = transport(EMessagePlatform.Signal);
    MessagingAdapter.instance.setup();
    Notices.instance.setup();
    await EventBus.instance.start();

    await EventBus.instance.publish({
      type: EEventType.AiAuthLoginNeeded,
      source: "test",
      key: "global",
      trace: { turnId: "test:global", chatId: undefined, platform: undefined },
      payload: { problems: ["openai-codex: login expired."] },
      causationId: undefined,
      dedupeKey: undefined,
    });
    await EventBus.instance.idle();
    authorized.mockRestore();

    const text = "AI login needed:\n- openai-codex: login expired.";
    expect(sendText.mock.calls.toSorted()).toEqual([
      ["+400", text],
      ["+500", text],
    ]);
  });

  test("an event under the old key of a linked address is stored in and sent for the account's Bella conversation", async () => {
    await link(EMessagePlatform.Signal, "+601", "acct-4", 1_000);
    await link(EMessagePlatform.Signal, "+600", "acct-4", 2_000);
    const sendText = transport(EMessagePlatform.Signal);
    MessagingAdapter.instance.setup();
    MessageHandler.instance.setup();
    await EventBus.instance.start();

    // a reminder prepared before the link
    await EventBus.instance.publish({
      type: EEventType.DeliveryReady,
      source: "test",
      key: "signal:+600",
      trace: { turnId: "test:old-delivery", chatId: "signal:+600", platform: undefined },
      payload: {
        chatId: "signal:+600",
        text: "Reminder",
        transcript: { text: "[CRON REMINDER daily]: Reminder", notice: "notice" },
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    // a message sent before the link and stored after it
    await EventBus.instance.publish({
      type: EEventType.MessageSent,
      source: "test",
      key: "signal:+600",
      trace: { turnId: "test:old-sent", chatId: "signal:+600", platform: undefined },
      payload: {
        chatId: "signal:+600",
        channel: EMessagePlatform.Signal,
        sourceType: EEventType.DeliveryReady,
        chars: 5,
        sentAt: Date.now(),
        transcript: { text: "[CRON REMINDER other]: Older", notice: "notice" },
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    await EventBus.instance.idle();

    expect(sendText.mock.calls).toEqual([["+601", "Reminder"]]);
    // the delivery's message.sent runs on the Bella conversation's lane; the old one keeps its key
    // and is forwarded to that lane
    expect((await eventsOf(EEventType.MessageSent)).map((row) => row.key).toSorted()).toEqual([
      "bella:acct-4",
      "bella:acct-4",
      "signal:+600",
    ]);
    // each delivery stores its notice and its text
    expect(await rows("bella:acct-4")).toHaveLength(4);
    expect(await rows("signal:+600")).toEqual([]);
  });

  test("an old-key message.sent handled during a Bella turn is stored after that turn's rows, once, also when delivered twice", async () => {
    await link(EMessagePlatform.Signal, "+800", "acct-6", 1_000);
    mockSettings();
    let releaseTurn = () => {};
    const turnHeld = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const runMain = mock(async (args: Parameters<AgentHarness["runMain"]>[0]) => {
      await turnHeld;
      const messages: Message[] = [
        { role: "user", content: args.prompt, timestamp: Date.now() },
        fauxAssistantMessage("Main reply"),
      ];
      return {
        text: "Main reply",
        iterations: 1,
        toolCallCount: 0,
        stopReason: "completed",
        messages,
      };
    });
    Object.assign(MessageHandler.instance, {
      ai: { runMain, compactConversation: mock(async () => undefined) },
    });
    MessageHandler.instance.setup();
    await EventBus.instance.start();

    await EventBus.instance.publish({
      type: EEventType.TurnRequested,
      source: "test",
      key: "bella:acct-6",
      trace: { turnId: "test:bella-turn", chatId: "bella:acct-6", platform: undefined },
      payload: {
        conversationKey: "bella:acct-6",
        ownerKey: "account:acct-6",
        channel: EMessagePlatform.Signal,
        replyAddress: "+800",
        content: "Hello",
        attachments: [],
        receivedAt: Date.now(),
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    while (runMain.mock.calls.length === 0) {
      await Bun.sleep(1);
    }
    // a message sent before the link, stored while the turn runs
    await EventBus.instance.publish({
      type: EEventType.MessageSent,
      source: "test",
      key: "signal:+800",
      trace: { turnId: "test:old-sent-during-turn", chatId: "signal:+800", platform: undefined },
      payload: {
        chatId: "signal:+800",
        channel: EMessagePlatform.Signal,
        sourceType: EEventType.DeliveryReady,
        chars: 5,
        sentAt: Date.now(),
        transcript: { text: "[CRON REMINDER daily]: Reminder", notice: "notice" },
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    // the old delivery is acked once its forward to the Bella conversation's lane commits
    const deadline = Date.now() + 5_000;
    while (true) {
      const [old] = await DatabaseConnector.instance.database
        .select({ status: eventDeliveriesTable.status })
        .from(eventDeliveriesTable)
        .innerJoin(eventsTable, eq(eventsTable.seq, eventDeliveriesTable.eventSeq))
        .where(eq(eventsTable.key, "signal:+800"));

      if (old?.status === "done") {
        break;
      }

      if (Date.now() > deadline) {
        throw new Error("The old message.sent was not acked");
      }

      await Bun.sleep(1);
    }
    releaseTurn();
    await EventBus.instance.idle();

    // the old event is delivered again after a restart
    const old = await DatabaseConnector.instance.database
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(eq(eventsTable.key, "signal:+800"));
    await DatabaseConnector.instance.database
      .update(eventDeliveriesTable)
      .set({ status: "pending", attempts: 0 })
      .where(eq(eventDeliveriesTable.eventSeq, old[0]?.seq ?? 0));
    await EventBus.instance.stop();
    Object.assign(EventBus, { _instance: undefined });
    MessageHandler.instance.setup();
    await EventBus.instance.start();
    await EventBus.instance.idle();

    const stored = await DatabaseConnector.instance.database
      .select({ author: memoriesTable.author, message: memoriesTable.message })
      .from(memoriesTable)
      .where(eq(memoriesTable.chatId, "bella:acct-6"))
      .orderBy(asc(memoriesTable.id));
    expect(stored.map((row) => row.author)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(stored.map((row) => row.message).slice(2)).toEqual([
      "notice",
      "[CRON REMINDER daily]: Reminder",
    ]);
    expect(await rows("signal:+800")).toEqual([]);
  });

  test("an address whose link is still migrating keeps its own chat", async () => {
    await link(EMessagePlatform.Signal, "+700", "acct-5", 1_000, EIdentityLinkState.Migrating);

    expect(await IdentityService.instance.resolve("signal:+700")).toEqual({
      conversationKey: "signal:+700",
      ownerKey: "signal:+700",
      destination: { channel: EMessagePlatform.Signal, address: "+700" },
    });
  });
});
