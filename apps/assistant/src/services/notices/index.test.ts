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
    MessagingAdapter.instance.registerTransport({ platform: EMessagePlatform.Signal, sendText });
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
});
