import { afterEach, describe, expect, mock, test } from "bun:test";
import { ECronJobType, type TCronJobContext } from "../../lib/cron-engine";
import { ERole } from "../ai/types";
import { Memory } from "../memory";
import { EMemoryImportance } from "../memory/types";
import { MessageHandler } from "../message-handler";
import { SettingsService } from "../settings";
import { DefaultConfigRecord } from "../settings/schema";
import { MessagingAdapter } from ".";
import { EMessagePlatform, type TMessageTransport } from "./types";

type TAdapterInternals = {
  ai: {
    completeText: ReturnType<typeof mock>;
    runScheduledTask: ReturnType<typeof mock>;
  };
  transports: Map<EMessagePlatform, TMessageTransport>;
  inboundChatQueues: Map<string, unknown>;
  runningCronTaskKeys: Set<string>;
  handleCronFire(ctx: TCronJobContext): Promise<void>;
};

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
  (MessagingAdapter as unknown as { _instance: unknown })._instance = undefined;
  (Memory as unknown as { _instance: unknown })._instance = undefined;
  (SettingsService as unknown as { _instance: unknown })._instance = undefined;
}

afterEach(reset);

describe("MessagingAdapter", () => {
  test("delivers the sole MessageHandler result and absorbs transport failures", async () => {
    const originalGetInstance = MessageHandler.getInstance;
    const handleMessage = mock(async () => "Root reply");
    const saveAssistantMessage = mock(async () => undefined);
    MessageHandler.getInstance = mock(() => ({
      handleMessage,
      saveAssistantMessage,
    })) as unknown as typeof MessageHandler.getInstance;
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    const internals = adapter as unknown as TAdapterInternals;

    await adapter.handleInboundMessage({
      platform: EMessagePlatform.Signal,
      chatId: "+100",
      author: { id: "1", username: "Owner" },
      message: { type: "text", content: "hello" },
    });
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("+100", "Root reply");
    expect(saveAssistantMessage).toHaveBeenCalledTimes(1);

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
    expect(saveAssistantMessage).toHaveBeenCalledTimes(1);
    expect(internals.inboundChatQueues.size).toBe(0);
    MessageHandler.getInstance = originalGetInstance;
  });

  test("serializes complete inbound turns for the same canonical chat and cleans up its queue", async () => {
    const originalGetInstance = MessageHandler.getInstance;
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstWaiting = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const handleMessage = mock(async (message: { message: { content: string } }) => {
      events.push(`generate:${message.message.content}`);

      if (message.message.content === "first") {
        markFirstStarted();
        await firstWaiting;
      }

      return `reply:${message.message.content}`;
    });
    const saveAssistantMessage = mock(
      async (message: { message: { content: string } }, response: string) => {
        events.push(`save:${message.message.content}:${response}`);
      },
    );
    MessageHandler.getInstance = mock(() => ({
      handleMessage,
      saveAssistantMessage,
    })) as unknown as typeof MessageHandler.getInstance;
    const sendText = mock(async (_chatId: string, text: string) => {
      events.push(`send:${text}`);
    });
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    const internals = adapter as unknown as TAdapterInternals;

    const first = adapter.handleInboundMessage({
      platform: EMessagePlatform.Signal,
      chatId: "+100",
      author: { id: "1", username: "Owner" },
      message: { type: "text", content: "first" },
    });
    await firstStarted;
    const second = adapter.handleInboundMessage({
      platform: EMessagePlatform.Signal,
      chatId: "+100",
      author: { id: "1", username: "Owner" },
      message: { type: "text", content: "second" },
    });
    await Promise.resolve();

    expect(events).toEqual(["generate:first"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual([
      "generate:first",
      "send:reply:first",
      "save:first:reply:first",
      "generate:second",
      "send:reply:second",
      "save:second:reply:second",
    ]);
    expect(internals.inboundChatQueues.size).toBe(0);
    MessageHandler.getInstance = originalGetInstance;
  });

  test("processes different canonical chats concurrently", async () => {
    const originalGetInstance = MessageHandler.getInstance;
    let releaseFirst: () => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstWaiting = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const completed: string[] = [];
    const handleMessage = mock(async (message: { chatId: string }) => {
      if (message.chatId === "signal:+100") {
        markFirstStarted();
        await firstWaiting;
      }

      completed.push(message.chatId);
      return message.chatId;
    });
    const saveAssistantMessage = mock(async () => undefined);
    MessageHandler.getInstance = mock(() => ({
      handleMessage,
      saveAssistantMessage,
    })) as unknown as typeof MessageHandler.getInstance;
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });

    const first = adapter.handleInboundMessage({
      platform: EMessagePlatform.Signal,
      chatId: "+100",
      author: { id: "1", username: "Owner" },
      message: { type: "text", content: "first" },
    });
    await firstStarted;
    await adapter.handleInboundMessage({
      platform: EMessagePlatform.Signal,
      chatId: "+200",
      author: { id: "1", username: "Owner" },
      message: { type: "text", content: "second" },
    });

    expect(completed).toEqual(["signal:+200"]);

    releaseFirst();
    await first;
    expect(completed).toEqual(["signal:+200", "signal:+100"]);
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
