import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ECronJobType, type TCronJobContext } from "../../lib/cron-engine";
import { ERole } from "../ai/types";
import {
  AuthorizationService,
  EAuthorizationDecision,
  type TAuthorizationResult,
} from "../authorization";
import { Memory } from "../memory";
import { EMemoryImportance } from "../memory/types";
import { MessageHandler } from "../message-handler";
import { getMessageTrace } from "../message-handler/trace";
import type { TIncommingMessage } from "../message-handler/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord } from "../settings/schema";
import { MessagingAdapter } from ".";
import { EMessagePlatform, type TMessageTransport } from "./types";

type TAdapterInternals = {
  authorization: {
    authorize: ReturnType<typeof mock>;
  };
  ai: {
    completeText: ReturnType<typeof mock>;
    runScheduledTask: ReturnType<typeof mock>;
  };
  transports: Map<EMessagePlatform, TMessageTransport>;
  runningCronTaskKeys: Set<string>;
  transportWaitAttempts: number;
  transportWaitIntervalMs: number;
  handleCronFire(ctx: TCronJobContext): Promise<void>;
};

const originalActivationToken = Bun.env.BELLACLAW_ACTIVATION_TOKEN;

function authorizationResult(
  decision: EAuthorizationDecision,
  failedAttempts: number,
): TAuthorizationResult {
  return { decision, failedAttempts };
}

function cron(overrides: Partial<TCronJobContext> = {}): TCronJobContext {
  return {
    name: "daily",
    scope: "signal:+100",
    group: undefined,
    type: ECronJobType.Recurring,
    pattern: "0 9 * * *",
    reminderText: "Take a break.",
    reminderPromptData: undefined,
    reminderFallbackText: undefined,
    taskPrompt: undefined,
    taskFallbackText: undefined,
    lastRunAt: undefined,
    nextRunAt: new Date("2026-07-24T08:00:00.000Z"),
    createdAt: new Date("2026-07-01T08:00:00.000Z"),
    timezone: "Europe/Warsaw",
    ...overrides,
  };
}

function reset() {
  (AuthorizationService as unknown as { _instance: unknown })._instance = undefined;
  (MessagingAdapter as unknown as { _instance: unknown })._instance = undefined;
  (Memory as unknown as { _instance: unknown })._instance = undefined;
  (SettingsService as unknown as { _instance: unknown })._instance = undefined;
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
      author: { id: "user-1", username: "Owner" },
      message: { type: "text" as const, content: "wrong" },
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
      author: { id: "1", username: "Owner" },
      message: { type: "text", content: "hello" },
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
        author: { id: "1", username: "Owner" },
        message: { type: "text", content: "again" },
      }),
    ).resolves.toBeUndefined();
    MessageHandler.getInstance = originalGetInstance;
  });

  test("runs MCP prompt commands through the normal message pipeline with identity and trace", async () => {
    const originalGetInstance = MessageHandler.getInstance;
    const originalMcpConfig = Bun.env.BELLACLAW_MCP_CONFIG;
    const directory = await mkdtemp(join(tmpdir(), "bellaclaw-messaging-mcp-"));
    let receivedMessage: TIncommingMessage | undefined;
    let receivedPlatform: EMessagePlatform | undefined;
    const handleMessage = mock(async (message: TIncommingMessage, platform: EMessagePlatform) => {
      receivedMessage = message;
      receivedPlatform = platform;
      return "Prompt completed.";
    });
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
        author: { id: "user-1", username: "Owner" },
        message: {
          type: "text",
          content: '!mcp-prompt documents summarize {"style":"brief"}',
        },
      });

      expect(MessageHandler.getInstance).toHaveBeenCalledWith("discord:channel-1");
      expect(handleMessage).toHaveBeenCalledTimes(1);
      expect(receivedPlatform).toBe(EMessagePlatform.Discord);
      expect(receivedMessage).toEqual({
        chatId: "discord:channel-1",
        author: { type: ERole.User, id: "user-1", username: "Owner" },
        message: {
          type: "text",
          content:
            'Use MCP profile documents to run the explicitly requested prompt template summarize with arguments {"style":"brief"}.',
        },
      });
      expect(getMessageTrace(receivedMessage as TIncommingMessage)).toEqual({
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

  test("sends MCP connection notifications through the canonical chat transport", async () => {
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });

    await adapter.sendMcpConnectedMessage("signal:+15551234567", "documents");

    expect(sendText).toHaveBeenCalledWith("+15551234567", "Connected MCP profile documents.");
  });

  test("saves low-importance root memory only after successful reminder delivery", async () => {
    const save = mock(async (args) => args);
    (Memory as unknown as { _instance: unknown })._instance = { save };
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    const internals = adapter as unknown as TAdapterInternals;

    await internals.handleCronFire(cron());
    expect(sendText).toHaveBeenCalledWith("+100", "Take a break.");
    expect(save).toHaveBeenCalledWith({
      chatId: "signal:+100",
      author: ERole.Assistant,
      importance: EMemoryImportance.Low,
      message: "[CRON REMINDER daily]: Take a break.",
    });

    save.mockClear();
    sendText.mockImplementation(async () => {
      throw new Error("offline");
    });
    await internals.handleCronFire(cron({ name: "failed" }));
    expect(save).not.toHaveBeenCalled();
  });

  test("prevents overlapping scheduled tasks and delivers fallback output once", async () => {
    (SettingsService as unknown as { _instance: unknown })._instance = {
      getAll: mock(async () => DefaultConfigRecord),
    };
    const save = mock(async (args) => args);
    (Memory as unknown as { _instance: unknown })._instance = { save };
    const sendText = mock(async () => undefined);
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    const internals = adapter as unknown as TAdapterInternals;
    internals.ai = {
      completeText: mock(async () => undefined),
      runScheduledTask: mock(async () => {
        await waiting;
        return {
          text: " ",
          stopReason: "error",
          iterations: 1,
          toolCallCount: 0,
        };
      }),
    };
    const task = cron({
      reminderText: undefined,
      taskPrompt: "Prepare briefing.",
      taskFallbackText: "Briefing unavailable.",
    });

    const first = internals.handleCronFire(task);
    await Promise.resolve();
    await internals.handleCronFire(task);
    release();
    await first;

    expect(internals.ai.runScheduledTask).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("+100", "Briefing unavailable.");
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "[CRON TASK daily]: Briefing unavailable.",
      }),
    );
    expect(internals.runningCronTaskKeys.size).toBe(0);
  });

  test("waits for a still-connecting transport before giving up on a cron delivery", async () => {
    const adapter = MessagingAdapter.instance as unknown as TAdapterInternals;
    const sendTextMock = mock(async () => {});

    adapter.transportWaitAttempts = 20;
    adapter.transportWaitIntervalMs = 1;
    adapter.transports.clear();

    setTimeout(() => {
      adapter.transports.set(EMessagePlatform.Signal, {
        platform: EMessagePlatform.Signal,
        sendText: sendTextMock,
      });
    }, 5);

    await adapter.handleCronFire(cron({ reminderText: "Take a break." }));

    expect(sendTextMock).toHaveBeenCalledWith("+100", "Take a break.");
  });
});
