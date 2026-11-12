import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TOption } from "@bellaclaw/shared";
import { asc, eq } from "drizzle-orm";
import { Commands } from "../commands";
import { DatabaseConnector } from "../database";
import { eventsTable } from "../database/schema";
import { resetEventTables, resetMessageAuthorizationsTable } from "../database/test-utils";
import { EventBus } from "../events";
import { EEventType } from "../events/catalog";
import { EMessagePlatform } from "../messaging/types";
import { AuthorizationService } from ".";
import { EAuthorizationDecision, EAuthorizationStatus } from "./schema";

type TAuthorizationServiceStatic = {
  _instance: TOption<AuthorizationService>;
};

const originalActivationToken = Bun.env.BELLACLAW_ACTIVATION_TOKEN;

function resetSingletons() {
  const service = AuthorizationService as unknown as TAuthorizationServiceStatic;
  service._instance = undefined;
  Object.assign(Commands, { _instance: undefined });
  Object.assign(EventBus, { _instance: undefined });
}

async function expectAuthorization(
  chatId: string,
  content: string,
  decision: EAuthorizationDecision,
  failedAttempts: number,
) {
  const result = await AuthorizationService.instance.authorize(
    DatabaseConnector.instance.database,
    chatId,
    content,
  );

  expect({ decision: result.decision, failedAttempts: result.failedAttempts }).toEqual({
    decision,
    failedAttempts,
  });
}

beforeEach(async () => {
  resetSingletons();
  Bun.env.BELLACLAW_ACTIVATION_TOKEN = "open-sesame";
  await resetMessageAuthorizationsTable();
  await resetEventTables();
});

afterEach(() => {
  resetSingletons();
  Bun.env.BELLACLAW_ACTIVATION_TOKEN = originalActivationToken;
});

describe("AuthorizationService.authorize", () => {
  test("allows every message when activation is disabled", async () => {
    Bun.env.BELLACLAW_ACTIVATION_TOKEN = "   ";

    await expectAuthorization("discord:user-1", "hello", EAuthorizationDecision.Allow, 0);
  });

  test("authorizes a sender and restores authorization from the database", async () => {
    await expectAuthorization(
      "discord:user-1",
      "  open-sesame\n",
      EAuthorizationDecision.Activated,
      0,
    );
    await expectAuthorization("discord:user-1", "normal message", EAuthorizationDecision.Allow, 0);
    await expectAuthorization(
      "discord:user-1",
      "open-sesame",
      EAuthorizationDecision.AlreadyActivated,
      0,
    );

    resetSingletons();

    await expectAuthorization(
      "discord:user-1",
      "normal after restart",
      EAuthorizationDecision.Allow,
      0,
    );
  });

  test("keeps a sender locked across restarts after three failed messages", async () => {
    await expectAuthorization("signal:+100", "first", EAuthorizationDecision.FailedAttempt, 1);
    await expectAuthorization("signal:+100", "second", EAuthorizationDecision.FailedAttempt, 2);
    await expectAuthorization("signal:+100", "third", EAuthorizationDecision.Locked, 3);
    await expectAuthorization("signal:+100", "open-sesame", EAuthorizationDecision.Locked, 3);

    resetSingletons();

    await expectAuthorization("signal:+100", "open-sesame", EAuthorizationDecision.Locked, 3);
  });

  test("tracks platform identities separately", async () => {
    await expectAuthorization("discord:owner", "open-sesame", EAuthorizationDecision.Activated, 0);

    await expectAuthorization("discord:owner", "hello", EAuthorizationDecision.Allow, 0);
    await expectAuthorization("signal:owner", "hello", EAuthorizationDecision.FailedAttempt, 1);
  });
});

describe("authorization consumer", () => {
  let bus: EventBus;

  async function receive(chatId: string, content: string, dedupeKey: TOption<string>) {
    await bus.publish({
      type: EEventType.MessageReceived,
      source: "test",
      key: chatId,
      trace: { turnId: "test:auth", chatId, platform: EMessagePlatform.Signal },
      payload: { chatId, content, receivedAt: 1, platform: EMessagePlatform.Signal },
      causationId: undefined,
      dedupeKey,
    });
    await bus.idle();
  }

  async function payloadsOf(type: EEventType) {
    const rows = await DatabaseConnector.instance.database
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.type, type))
      .orderBy(asc(eventsTable.seq));
    return rows.map((row) => row.payload);
  }

  beforeEach(async () => {
    bus = EventBus.instance;
    await AuthorizationService.instance.setup();
    Commands.instance.setup();
    await bus.start();
  });

  afterEach(async () => {
    await bus.idle();
    await bus.stop();
  });

  test("rejects silently, replies to activation and authorizes later messages", async () => {
    await receive("signal:+200", "wrong", undefined);
    expect(await payloadsOf(EEventType.MessageRejected)).toEqual([
      { chatId: "signal:+200", decision: EAuthorizationDecision.FailedAttempt, failedAttempts: 1 },
    ]);
    expect(await payloadsOf(EEventType.ReplyReady)).toEqual([]);

    await receive("signal:+200", "open-sesame", undefined);
    await receive("signal:+200", "open-sesame", undefined);
    expect(await payloadsOf(EEventType.ReplyReady)).toEqual([
      { chatId: "signal:+200", text: "Activated." },
      { chatId: "signal:+200", text: "Already activated." },
    ]);
    expect(await payloadsOf(EEventType.MessageAuthorized)).toEqual([]);

    await receive("signal:+200", "hello", undefined);
    expect(await payloadsOf(EEventType.TurnRequested)).toEqual([
      expect.objectContaining({ chatId: "signal:+200", content: "hello" }),
    ]);
    expect(await payloadsOf(EEventType.AuthorizationChanged)).toEqual([
      { chatId: "signal:+200", status: EAuthorizationStatus.Pending, failedAttempts: 1 },
      { chatId: "signal:+200", status: EAuthorizationStatus.Authorized, failedAttempts: 0 },
    ]);
  });

  test("a command replayed right after activation sees the activated chat", async () => {
    // both messages are pending before start(), as after a restart, so they share the lane
    await bus.stop();
    resetSingletons();
    bus = EventBus.instance;
    await AuthorizationService.instance.setup();
    Commands.instance.setup();
    for (const content of ["open-sesame", "!ai-auth status openai-codex"]) {
      await bus.publish({
        type: EEventType.MessageReceived,
        source: "test",
        key: "signal:+200",
        trace: { turnId: "test:auth", chatId: "signal:+200", platform: EMessagePlatform.Signal },
        payload: {
          chatId: "signal:+200",
          content,
          receivedAt: 1,
          platform: EMessagePlatform.Signal,
        },
        causationId: undefined,
        dedupeKey: undefined,
      });
    }
    await bus.start();
    await bus.idle();

    const replies = await payloadsOf(EEventType.ReplyReady);
    expect(replies[0]).toEqual({ chatId: "signal:+200", text: "Activated." });
    expect(replies[1]).not.toEqual(
      expect.objectContaining({ text: expect.stringContaining("activated chat") }),
    );
  });

  test("a wrong token three times locks the chat", async () => {
    await receive("signal:+200", "one", undefined);
    await receive("signal:+200", "two", undefined);
    await receive("signal:+200", "three", undefined);
    await receive("signal:+200", "open-sesame", undefined);

    expect(await payloadsOf(EEventType.MessageRejected)).toEqual([
      { chatId: "signal:+200", decision: EAuthorizationDecision.FailedAttempt, failedAttempts: 1 },
      { chatId: "signal:+200", decision: EAuthorizationDecision.FailedAttempt, failedAttempts: 2 },
      { chatId: "signal:+200", decision: EAuthorizationDecision.Locked, failedAttempts: 3 },
      { chatId: "signal:+200", decision: EAuthorizationDecision.Locked, failedAttempts: 3 },
    ]);
    expect(await payloadsOf(EEventType.ReplyReady)).toEqual([]);
  });

  test("a redelivered message.received with a wrong token counts one failed attempt", async () => {
    await receive("signal:+200", "wrong", "signal:+200:123");
    await receive("signal:+200", "wrong", "signal:+200:123");

    expect(await payloadsOf(EEventType.MessageReceived)).toHaveLength(1);
    expect(await payloadsOf(EEventType.MessageRejected)).toEqual([
      { chatId: "signal:+200", decision: EAuthorizationDecision.FailedAttempt, failedAttempts: 1 },
    ]);
  });

  test("message.received and message.authorized lose their payloads once handled", async () => {
    await receive("signal:+200", "open-sesame", undefined);
    await receive("signal:+200", "hello", undefined);

    expect(await payloadsOf(EEventType.MessageReceived)).toEqual([null, null]);
    expect(await payloadsOf(EEventType.MessageAuthorized)).toEqual([null]);
    expect(await payloadsOf(EEventType.TurnRequested)).toHaveLength(1);
  });

  test("the cache changes only through authorization.changed", async () => {
    const service = AuthorizationService.instance;

    await service.authorize(DatabaseConnector.instance.database, "signal:+300", "open-sesame");
    expect(await service.listAuthorizedChatIds()).toEqual([]);

    await bus.publish({
      type: EEventType.AuthorizationChanged,
      source: "test",
      key: "signal:+400",
      trace: { turnId: "test:auth", chatId: "signal:+400", platform: undefined },
      payload: {
        chatId: "signal:+400",
        status: EAuthorizationStatus.Authorized,
        failedAttempts: 0,
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    await bus.idle();
    expect(await service.listAuthorizedChatIds()).toEqual(["signal:+400"]);

    await receive("signal:+200", "open-sesame", undefined);
    expect(await service.listAuthorizedChatIds()).toEqual(["signal:+400", "signal:+200"]);
  });
});
