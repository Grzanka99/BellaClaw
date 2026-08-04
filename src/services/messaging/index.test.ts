import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
});
