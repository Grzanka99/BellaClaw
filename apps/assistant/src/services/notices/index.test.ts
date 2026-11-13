import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AuthorizationService } from "../authorization";
import { DatabaseConnector } from "../database";
import { eventsTable } from "../database/schema";
import { resetEventTables } from "../database/test-utils";
import { EventBus, type TEventDraft } from "../events";
import { EEventType, type TEventPayloads } from "../events/catalog";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
import { Notices } from ".";

function draft<T extends EEventType>(
  type: T,
  key: string,
  payload: TEventPayloads[T],
): TEventDraft<T> {
  return {
    type,
    source: "test",
    key,
    trace: { turnId: "sys:test", chatId: undefined, platform: undefined },
    payload,
    causationId: undefined,
    dedupeKey: undefined,
  };
}

describe("Notices", () => {
  let bus: EventBus;
  let sendText: ReturnType<typeof mock>;

  beforeEach(async () => {
    await resetEventTables();
    Object.assign(EventBus, { _instance: undefined });
    Object.assign(MessagingAdapter, { _instance: undefined });
    Object.assign(Notices, { _instance: undefined });
    bus = EventBus.instance;
    sendText = mock(async () => undefined);
    MessagingAdapter.instance.registerTransport({
      platform: EMessagePlatform.Signal,
      sendText,
      fetchAttachment: async () => new Uint8Array(),
      deleteAttachment: async () => undefined,
    });
    MessagingAdapter.instance.setup();
    Notices.instance.setup();
    await bus.start();
  });

  afterEach(async () => {
    await bus.idle();
    await bus.stop();
  });

  test("mcp.auth.connected reaches the chat through notice.ready", async () => {
    await bus.publish(
      draft(EEventType.McpAuthConnected, "signal:+100", {
        chatId: "signal:+100",
        profileId: "documents",
      }),
    );
    await bus.idle();

    expect(sendText.mock.calls).toEqual([["+100", "Connected MCP profile documents."]]);
  });

  test("ai.auth.login.needed fans out to every authorized chat", async () => {
    const authorized = spyOn(
      AuthorizationService.instance,
      "listAuthorizedChatIds",
    ).mockResolvedValue(["signal:+100", "signal:+200"]);

    try {
      await bus.publish(
        draft(EEventType.AiAuthLoginNeeded, "global", {
          problems: ["opencode-go: not connected. Run !ai-auth login opencode-go"],
        }),
      );
      await bus.idle();
    } finally {
      authorized.mockRestore();
    }

    const text = "AI login needed:\n- opencode-go: not connected. Run !ai-auth login opencode-go";
    expect(sendText.mock.calls).toEqual([
      ["+100", text],
      ["+200", text],
    ]);
    // each notice is on its chat's lane, not the cause's global one
    const notices = await DatabaseConnector.instance.database
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.NoticeReady));
    expect(notices.map((row) => row.key)).toEqual(["signal:+100", "signal:+200"]);
  });

  test("a supervisor notice fans out to every authorized chat", async () => {
    const authorized = spyOn(
      AuthorizationService.instance,
      "listAuthorizedChatIds",
    ).mockResolvedValue(["signal:+100", "signal:+200"]);

    try {
      await Notices.instance.handleSupervisorMessage({
        type: "notice",
        text: "Updated to abc1234",
      });
      await bus.idle();
    } finally {
      authorized.mockRestore();
    }

    expect(sendText.mock.calls).toEqual([
      ["+100", "Updated to abc1234"],
      ["+200", "Updated to abc1234"],
    ]);
  });

  test("login outcomes become chat notices", async () => {
    await bus.publish(
      draft(EEventType.AiAuthLoginCompleted, "signal:+100", {
        chatId: "signal:+100",
        providerId: "openai-codex",
        selected: true,
      }),
    );
    await bus.publish(
      draft(EEventType.AiAuthLoginFailed, "signal:+100", {
        chatId: "signal:+100",
        providerId: "opencode-go",
        error: "Error: denied",
      }),
    );
    await bus.idle();

    expect(sendText.mock.calls).toEqual([
      ["+100", "Connected openai-codex. It is now this chat's AI provider."],
      ["+100", "Login for opencode-go failed: Error: denied"],
    ]);
  });

  test("a dead event becomes a notice to its chat; loop-prone types and commands get none", async () => {
    for (const eventType of [
      EEventType.ReplyReady,
      EEventType.DeliveryReady,
      EEventType.NoticeReady,
      EEventType.EventDeadLettered,
      EEventType.SettingsUpdateRequested,
      EEventType.CronFired,
    ]) {
      await bus.publish({
        ...draft(EEventType.EventDeadLettered, "signal:+100|daily", {
          eventId: `dead-${eventType}`,
          eventType,
          consumer: "test",
          attempts: 3,
          error: "Error: boom",
        }),
        trace: { turnId: "cron:test", chatId: "signal:+100", platform: undefined },
      });
    }
    await bus.idle();

    expect(sendText.mock.calls).toEqual([
      ["+100", "Something I was doing failed and was dropped. Try again."],
    ]);
    // the notice runs on the chat's lane, not the dead event's
    const notices = await DatabaseConnector.instance.database
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.NoticeReady));
    expect(notices.map((row) => row.key)).toEqual(["signal:+100"]);
  });

  test("a dead event of no chat notifies every authorized chat", async () => {
    const authorized = spyOn(
      AuthorizationService.instance,
      "listAuthorizedChatIds",
    ).mockResolvedValue(["signal:+100", "signal:+200"]);

    try {
      await bus.publish(
        draft(EEventType.EventDeadLettered, "global", {
          eventId: "dead-app-started",
          eventType: EEventType.AppStarted,
          consumer: "test",
          attempts: 1,
          error: "Error: boom",
        }),
      );
      await bus.idle();
    } finally {
      authorized.mockRestore();
    }

    const text = "Something I was doing failed and was dropped. Try again.";
    expect(sendText.mock.calls).toEqual([
      ["+100", text],
      ["+200", text],
    ]);
  });
});
