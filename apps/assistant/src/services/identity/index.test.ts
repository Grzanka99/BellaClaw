import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  ECronJobType,
  EEventType,
  eventsTable,
  memoriesTable,
  messageAuthorizationsTable,
} from "@bellaclaw/database";
import { asc, eq } from "drizzle-orm";
import type { AgentHarness } from "../ai/agent-harness";
import { AuthorizationService } from "../authorization";
import { EAuthorizationStatus } from "../authorization/schema";
import { Commands } from "../commands";
import { DatabaseConnector } from "../database";
import {
  linkTestAddress,
  resetEventTables,
  resetIdentityLinksTable,
  resetMessageAuthorizationsTable,
} from "../database/test-utils";
import { EventBus } from "../events";
import { publishTestMessage } from "../events/test-utils";
import { MessageHandler } from "../message-handler";
import { scriptedReply } from "../message-handler/test-utils";
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
  return linkTestAddress(address, accountId, channel, state, linkedAt);
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
    const runMain = mock(async (args: Parameters<AgentHarness["runMain"]>[0]) =>
      scriptedReply({ ...args, conversation: undefined }, "Main reply"),
    );
    Object.assign(MessageHandler.instance, {
      ai: { runMain, compactConversation: mock(async () => undefined) },
    });
    const sendText = transport(EMessagePlatform.Signal);
    await AuthorizationService.instance.setup();
    Commands.instance.setup();
    MessageHandler.instance.setup();
    MessagingAdapter.instance.setup();
    await EventBus.instance.start();

    await publishTestMessage("signal:+200", "Hello");

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
});
