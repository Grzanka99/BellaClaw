import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import { eq } from "drizzle-orm";
import { ERole } from "../ai/types";
import {
  AuthorizationService,
  EAuthorizationDecision,
  type TAuthorizationResult,
} from "../authorization";
import { DatabaseConnector } from "../database";
import { eventDeliveriesTable, eventsTable } from "../database/schema";
import { resetEventTables } from "../database/test-utils";
import { EventBus, type TEventDraft } from "../events";
import { EEventType } from "../events/catalog";
import { Memory } from "../memory";
import { MessageHandler } from "../message-handler";
import type { TIncommingMessage } from "../message-handler/types";
import { SettingsService } from "../settings";
import { MessagingAdapter } from ".";
import { EMessagePlatform, type TPlatformMessage } from "./types";

type TAdapterInternals = {
  authorization: {
    authorize: ReturnType<typeof mock>;
  };
};

const originalActivationToken = Bun.env.BELLACLAW_ACTIVATION_TOKEN;

function authorizationResult(
  decision: EAuthorizationDecision,
  failedAttempts: number,
): TAuthorizationResult {
  return { decision, failedAttempts };
}

function reset() {
  (AuthorizationService as unknown as { _instance: unknown })._instance = undefined;
  (MessagingAdapter as unknown as { _instance: unknown })._instance = undefined;
  (Memory as unknown as { _instance: unknown })._instance = undefined;
  (SettingsService as unknown as { _instance: unknown })._instance = undefined;
  (MessageHandler as unknown as { _instances: Map<string, MessageHandler> })._instances.clear();
}

beforeEach(() => {
  reset();
  Bun.env.BELLACLAW_ACTIVATION_TOKEN = undefined;
});

afterEach(() => {
  reset();
  Bun.env.BELLACLAW_ACTIVATION_TOKEN = originalActivationToken;
});

describe("MessagingAdapter", () => {
  test("captures arrival before awaiting authorization", async () => {
    const arrival = new Date("2026-07-24T21:59:50.000Z");
    const originalGetInstance = MessageHandler.getInstance;
    const handleMessage = mock(async (_message: TIncommingMessage) => "Root reply");
    MessageHandler.getInstance = mock(() => ({
      handleMessage,
    })) as unknown as typeof MessageHandler.getInstance;
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({
      platform: EMessagePlatform.Signal,
      sendText: mock(async () => undefined),
    });
    const internals = adapter as unknown as TAdapterInternals;
    internals.authorization.authorize = mock(async () => {
      setSystemTime(new Date("2026-07-24T22:00:10.000Z"));
      return authorizationResult(EAuthorizationDecision.Allow, 0);
    });

    setSystemTime(arrival);
    try {
      await adapter.handleInboundMessage({
        platform: EMessagePlatform.Signal,
        chatId: "+100",
        message: { content: "What is on my calendar tomorrow?" },
      });

      expect(handleMessage.mock.calls[0]?.[0].receivedAt).toEqual(arrival);
    } finally {
      MessageHandler.getInstance = originalGetInstance;
      setSystemTime();
    }
  });

  test("silently rejects failures and handles activation without invoking the AI", async () => {
    const originalGetInstance = MessageHandler.getInstance;
    const handleMessage = mock(async () => "Root reply");
    MessageHandler.getInstance = mock(() => ({
      handleMessage,
    })) as unknown as typeof MessageHandler.getInstance;
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    const internals = adapter as unknown as TAdapterInternals;
    adapter.registerTransport({ platform: EMessagePlatform.Discord, sendText });
    const authorizationResults = [
      authorizationResult(EAuthorizationDecision.FailedAttempt, 1),
      authorizationResult(EAuthorizationDecision.Activated, 0),
      authorizationResult(EAuthorizationDecision.AlreadyActivated, 0),
      authorizationResult(EAuthorizationDecision.Allow, 0),
    ];
    internals.authorization = {
      authorize: mock(async () => {
        const result = authorizationResults.shift();

        if (result !== undefined) {
          return result;
        }

        throw new Error("Missing authorization result fixture");
      }),
    };

    const message = {
      platform: EMessagePlatform.Discord,
      chatId: "user-1",
      message: { content: "wrong" },
    };

    await adapter.handleInboundMessage(message);
    expect(sendText).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();

    message.message.content = "token";
    await adapter.handleInboundMessage(message);
    expect(sendText).toHaveBeenLastCalledWith("user-1", "Activated.");
    expect(handleMessage).not.toHaveBeenCalled();

    message.message.content = "token";
    await adapter.handleInboundMessage(message);
    expect(sendText).toHaveBeenLastCalledWith("user-1", "Already activated.");
    expect(handleMessage).not.toHaveBeenCalled();

    message.message.content = "hello";
    await adapter.handleInboundMessage(message);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenLastCalledWith("user-1", "Root reply");
    expect(internals.authorization.authorize).toHaveBeenCalledWith("discord:user-1", "wrong");

    MessageHandler.getInstance = originalGetInstance;
  });

  test("delivers the sole MessageHandler result and absorbs transport failures", async () => {
    const originalGetInstance = MessageHandler.getInstance;
    const handleMessage = mock(async () => "Root reply");
    MessageHandler.getInstance = mock(() => ({
      handleMessage,
    })) as unknown as typeof MessageHandler.getInstance;
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });

    await adapter.handleInboundMessage({
      platform: EMessagePlatform.Signal,
      chatId: "+100",
      message: { content: "hello" },
    });
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("+100", "Root reply");

    sendText.mockImplementation(async () => {
      throw new Error("offline");
    });
    await expect(
      adapter.handleInboundMessage({
        platform: EMessagePlatform.Signal,
        chatId: "+100",
        message: { content: "again" },
      }),
    ).resolves.toBeUndefined();
    MessageHandler.getInstance = originalGetInstance;
  });

  test("runs MCP prompt commands through the normal message pipeline with identity and trace", async () => {
    const originalGetInstance = MessageHandler.getInstance;
    const originalMcpConfig = Bun.env.BELLACLAW_MCP_CONFIG;
    const directory = await mkdtemp(join(tmpdir(), "bellaclaw-messaging-mcp-"));
    let receivedMessage: TIncommingMessage | undefined;
    let receivedTrace: TBehaviorTraceContext | undefined;
    let receivedPlatform: EMessagePlatform | undefined;
    const handleMessage = mock(
      async (
        message: TIncommingMessage,
        trace: TBehaviorTraceContext,
        platform: EMessagePlatform,
      ) => {
        receivedMessage = message;
        receivedTrace = trace;
        receivedPlatform = platform;
        return "Prompt completed.";
      },
    );
    MessageHandler.getInstance = mock(() => ({
      handleMessage,
    })) as unknown as typeof MessageHandler.getInstance;

    try {
      const configPath = join(directory, "mcp.json");
      await Bun.write(
        configPath,
        JSON.stringify({
          profiles: [
            {
              id: "documents",
              description: "Documents",
              instructions: "Use document prompts",
              transport: { type: "stdio", command: "unused" },
              prompts: true,
            },
          ],
        }),
      );
      Bun.env.BELLACLAW_MCP_CONFIG = configPath;

      const sendText = mock(async () => undefined);
      const adapter = MessagingAdapter.instance;
      adapter.registerTransport({ platform: EMessagePlatform.Discord, sendText });

      await adapter.handleInboundMessage({
        platform: EMessagePlatform.Discord,
        chatId: "channel-1",
        message: {
          content: '!mcp-prompt documents summarize {"style":"brief"}',
        },
      });

      expect(MessageHandler.getInstance).toHaveBeenCalledWith("discord:channel-1");
      expect(handleMessage).toHaveBeenCalledTimes(1);
      expect(receivedPlatform).toBe(EMessagePlatform.Discord);
      expect(receivedMessage).toEqual({
        chatId: "discord:channel-1",
        receivedAt: expect.any(Date),
        author: { type: ERole.User },
        message: {
          content:
            'Use MCP profile documents to run the explicitly requested prompt template summarize with arguments {"style":"brief"}.',
        },
      });
      expect(receivedTrace).toEqual({
        turnId: expect.any(String),
        chatId: "discord:channel-1",
        platform: EMessagePlatform.Discord,
      });
      expect(sendText).toHaveBeenCalledWith("channel-1", "Prompt completed.");
    } finally {
      MessageHandler.getInstance = originalGetInstance;
      if (originalMcpConfig === undefined) {
        delete Bun.env.BELLACLAW_MCP_CONFIG;
      } else {
        Bun.env.BELLACLAW_MCP_CONFIG = originalMcpConfig;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("replies when MCP prompt commands encounter configuration errors", async () => {
    const originalGetInstance = MessageHandler.getInstance;
    const originalMcpConfig = Bun.env.BELLACLAW_MCP_CONFIG;
    const directory = await mkdtemp(join(tmpdir(), "bellaclaw-messaging-mcp-errors-"));
    const handleMessage = mock(async () => "Unexpected AI reply");
    MessageHandler.getInstance = mock(() => ({
      handleMessage,
    })) as unknown as typeof MessageHandler.getInstance;

    try {
      const configPath = join(directory, "mcp.json");
      await Bun.write(configPath, JSON.stringify({ profiles: [] }));
      Bun.env.BELLACLAW_MCP_CONFIG = configPath;

      const sendText = mock(async () => undefined);
      const adapter = MessagingAdapter.instance;
      adapter.registerTransport({ platform: EMessagePlatform.Discord, sendText });
      const message: TPlatformMessage = {
        platform: EMessagePlatform.Discord,
        chatId: "channel-1",
        message: { content: "!mcp-prompt missing summarize" },
      };

      await adapter.handleInboundMessage(message);

      expect(sendText).toHaveBeenLastCalledWith(
        "channel-1",
        "MCP prompt request failed: Error: Unknown MCP profile: missing",
      );

      await Bun.write(configPath, JSON.stringify({ profiles: [{ id: "INVALID" }] }));
      message.message.content = "!mcp-prompts";
      await adapter.handleInboundMessage(message);

      expect(sendText).toHaveBeenLastCalledWith(
        "channel-1",
        expect.stringContaining("MCP prompt listing failed: Error: Invalid MCP configuration:"),
      );
      expect(handleMessage).not.toHaveBeenCalled();
    } finally {
      MessageHandler.getInstance = originalGetInstance;
      if (originalMcpConfig === undefined) {
        delete Bun.env.BELLACLAW_MCP_CONFIG;
      } else {
        Bun.env.BELLACLAW_MCP_CONFIG = originalMcpConfig;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("MessagingAdapter outbound", () => {
  let bus: EventBus;

  function notice(): TEventDraft<EEventType.NoticeReady> {
    return {
      type: EEventType.NoticeReady,
      source: "test",
      key: "signal:+100",
      trace: { turnId: "test:outbound", chatId: "signal:+100", platform: undefined },
      payload: { chatId: "signal:+100", text: "Notice" },
      causationId: undefined,
      dedupeKey: undefined,
    };
  }

  async function deliveries() {
    return DatabaseConnector.instance.database.select().from(eventDeliveriesTable);
  }

  async function sentEvents() {
    return DatabaseConnector.instance.database
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.MessageSent));
  }

  beforeEach(async () => {
    await resetEventTables();
    Object.assign(EventBus, { _instance: undefined });
    bus = EventBus.instance;
  });

  afterEach(async () => {
    await bus.idle();
    await bus.stop();
  });

  test("retries a missing transport and delivers once it registers", async () => {
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    Object.assign(adapter, { outboundBackoffMs: [20, 20, 20, 20, 20] });
    adapter.setup();
    await bus.start();

    await bus.publish(notice());
    while (((await deliveries())[0]?.attempts ?? 0) < 1) {
      await Bun.sleep(1);
    }
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    await bus.idle();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("+100", "Notice");
    expect((await deliveries()).map((row) => [row.consumer, row.status])).toEqual([
      ["outbound", "done"],
    ]);
    expect((await sentEvents()).map((row) => row.payload)).toEqual([
      {
        chatId: "signal:+100",
        sourceType: EEventType.NoticeReady,
        chars: 6,
        sentAt: expect.any(Number),
      },
    ]);
  });

  test("a failed send does not publish message.sent", async () => {
    const sendText = mock(async () => {
      throw new Error("offline");
    });
    const adapter = MessagingAdapter.instance;
    Object.assign(adapter, { outboundBackoffMs: [] });
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    adapter.setup();
    await bus.start();

    await bus.publish(notice());
    await bus.idle();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect((await deliveries()).map((row) => [row.consumer, row.status])).toEqual([
      ["outbound", "dead"],
    ]);
    expect(await sentEvents()).toEqual([]);
  });
});
