import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ECronJobType, type TCronJobContext } from "../../lib/cron-engine";
import type { TOption } from "../../types";
import { EAssistantLoopStopReason } from "../ai/api";
import { ERole } from "../ai/types";
import { CronSingleton } from "../cron";
import { Memory } from "../memory";
import { EMemoryImportance } from "../memory/types";
import { MessageHandler } from "../message-handler";
import type { TSettingsIntent } from "../settings-intent-classifier";
import { SettingsIntentClassifier } from "../settings-intent-classifier";
import { SettingsMessageHandler } from "../settings-message-handler";
import { MessagingAdapter } from "./index";
import { EMessagePlatform, type TMessageTransport } from "./types";

type TMessagingAdapterStatic = {
  _instance: MessagingAdapter | undefined;
};

type TMessagingAdapterInternals = {
  ai: {
    runToolTask?: typeof import("../ai/api").AiConnector.prototype.runToolTask;
    runAssistantToolLoop?: typeof import("../ai/api").AiConnector.prototype.runAssistantToolLoop;
  };
  classifier: {
    classify: typeof SettingsIntentClassifier.prototype.classify;
  };
  transports: Map<EMessagePlatform, TMessageTransport>;
  handleCronFire: (ctx: TCronJobContext) => Promise<void>;
};

type TCronSingletonStatic = {
  _instance: CronSingleton | undefined;
};

type TMemoryStatic = {
  _instance: Memory | undefined;
};

type TSettingsIntentClassifierStatic = {
  _instance: SettingsIntentClassifier | undefined;
};

function cleanupSingletons() {
  const MessagingAdapterWithInternals = MessagingAdapter as unknown as TMessagingAdapterStatic;
  MessagingAdapterWithInternals._instance = undefined;

  const CronSingletonWithInternals = CronSingleton as unknown as TCronSingletonStatic;
  CronSingletonWithInternals._instance?.destroy();
  CronSingletonWithInternals._instance = undefined;

  const MemoryWithInternals = Memory as unknown as TMemoryStatic;
  MemoryWithInternals._instance = undefined;

  (MessageHandler as unknown as { _instances: Map<string, MessageHandler> })._instances.clear();

  const ClassifierWithInternals =
    SettingsIntentClassifier as unknown as TSettingsIntentClassifierStatic;
  ClassifierWithInternals._instance = undefined;

  (
    SettingsMessageHandler as unknown as { _instances: Map<string, SettingsMessageHandler> }
  )._instances.clear();
}

function mockClassifierIntent(intent: TOption<TSettingsIntent>) {
  const ClassifierWithInternals =
    SettingsIntentClassifier as unknown as TSettingsIntentClassifierStatic;
  ClassifierWithInternals._instance = {
    classify: mock(async () => intent),
  } as unknown as SettingsIntentClassifier;
}

function createTransport(platform: EMessagePlatform) {
  const sendText = mock(async () => {});
  const transport: TMessageTransport = {
    platform,
    sendText,
  };

  return { transport, sendText };
}

function createCronContext(overrides: Partial<TCronJobContext> = {}): TCronJobContext {
  const now = new Date("2026-01-01T00:00:00.000Z");

  return {
    name: "study-checkin",
    scope: "discord:user-1",
    group: undefined,
    type: ECronJobType.Recurring,
    pattern: "*/30 * * * *",
    nextRunAt: now,
    lastRunAt: undefined,
    reminderText: undefined,
    reminderPromptData: undefined,
    reminderFallbackText: "Fallback reminder.",
    taskPrompt: undefined,
    taskFallbackText: undefined,
    createdAt: now,
    timezone: undefined,
    ...overrides,
  };
}

function mockMemoryInstance() {
  const MemoryWithInternals = Memory as unknown as TMemoryStatic;
  const saveMock = mock(async () => ({
    chatId: "discord:user-1",
    author: ERole.Assistant,
    importance: EMemoryImportance.Low,
    message: "saved",
    createdAt: new Date(),
    lastReadAt: new Date(),
  }));

  MemoryWithInternals._instance = {
    save: saveMock,
  } as unknown as Memory;

  return saveMock;
}

describe("MessagingAdapter", () => {
  beforeEach(() => {
    cleanupSingletons();
  });

  afterEach(() => {
    cleanupSingletons();
  });

  test("routes cron reminders to discord and signal transports", async () => {
    const adapter = MessagingAdapter.instance;
    const discord = createTransport(EMessagePlatform.Discord);
    const signal = createTransport(EMessagePlatform.Signal);
    const saveMock = mock(async () => ({
      chatId: "discord:123",
      author: ERole.Assistant,
      importance: EMemoryImportance.Low,
      message: "saved",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    const MemoryWithInternals = Memory as unknown as TMemoryStatic;
    MemoryWithInternals._instance = {
      save: saveMock,
    } as unknown as Memory;

    adapter.registerTransport(discord.transport);
    adapter.registerTransport(signal.transport);

    const internals = adapter as unknown as TMessagingAdapterInternals;

    await internals.handleCronFire(
      createCronContext({
        scope: "discord:123",
        reminderText: "time to move",
        reminderFallbackText: undefined,
      }),
    );
    await internals.handleCronFire(
      createCronContext({
        scope: "signal:+100",
        reminderText: "time to move",
        reminderFallbackText: undefined,
      }),
    );

    expect(discord.sendText).toHaveBeenCalledWith("123", "time to move");
    expect(signal.sendText).toHaveBeenCalledWith("+100", "time to move");
    expect(saveMock).toHaveBeenCalledTimes(2);
  });

  test("sends non-empty assistant replies through originating transport", async () => {
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    const adapter = MessagingAdapter.instance;
    const handleMessageMock = mock(async () => "test response");

    mockClassifierIntent({ intent: "normal", reason: "casual greeting" });

    (
      MessageHandler as unknown as {
        _instances: Map<string, { handleMessage: typeof handleMessageMock }>;
      }
    )._instances.set("discord:user-1", {
      handleMessage: handleMessageMock,
    });

    adapter.registerTransport({
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });

    await adapter.handleInboundMessage({
      platform: EMessagePlatform.Discord,
      chatId: "user-1",
      author: {
        id: "user-1",
        username: "TestUser",
      },
      message: {
        type: "text",
        content: "hello",
      },
    });

    expect(handleMessageMock).toHaveBeenCalledWith(
      {
        chatId: "discord:user-1",
        author: {
          type: ERole.User,
          id: "user-1",
          username: "TestUser",
        },
        message: {
          type: "text",
          content: "hello",
        },
      },
      EMessagePlatform.Discord,
    );
    expect(sendTextMock).toHaveBeenCalledWith("user-1", "test response");
  });

  test("does not send empty assistant replies", async () => {
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    const adapter = MessagingAdapter.instance;
    const handleMessageMock = mock(async () => "   ");

    mockClassifierIntent({ intent: "normal", reason: "casual greeting" });

    (
      MessageHandler as unknown as {
        _instances: Map<string, { handleMessage: typeof handleMessageMock }>;
      }
    )._instances.set("discord:user-1", {
      handleMessage: handleMessageMock,
    });

    adapter.registerTransport({
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });

    await adapter.handleInboundMessage({
      platform: EMessagePlatform.Discord,
      chatId: "user-1",
      author: {
        id: "user-1",
        username: "TestUser",
      },
      message: {
        type: "text",
        content: "hello",
      },
    });

    expect(sendTextMock).toHaveBeenCalledTimes(0);
  });

  test("uses generated reminder text when reminderPromptData is present", async () => {
    const adapter = MessagingAdapter.instance as unknown as TMessagingAdapterInternals;
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    const runToolTaskMock = mock(async () => ({
      assistantResponse: "Stay focused on your study session.",
      toolCalls: [],
      toolResults: [],
    }));

    mockMemoryInstance();
    adapter.transports.set(EMessagePlatform.Discord, {
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });
    adapter.ai = {
      runToolTask: runToolTaskMock,
    };

    await adapter.handleCronFire(
      createCronContext({
        reminderPromptData: '{"topic":"study","tone":"encouraging"}',
      }),
    );

    expect(runToolTaskMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock).toHaveBeenCalledWith("user-1", "Stay focused on your study session.");
  });

  test("routes cron reminders by canonical platform scope", async () => {
    const adapter = MessagingAdapter.instance as unknown as TMessagingAdapterInternals;
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    const saveMock = mockMemoryInstance();

    adapter.transports.set(EMessagePlatform.Discord, {
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });

    await adapter.handleCronFire(
      createCronContext({
        reminderText: "Reminder text.",
      }),
    );

    expect(sendTextMock).toHaveBeenCalledWith("user-1", "Reminder text.");
    expect(saveMock).toHaveBeenCalledWith({
      chatId: "discord:user-1",
      author: ERole.Assistant,
      importance: EMemoryImportance.Low,
      message: "[CRON REMINDER study-checkin]: Reminder text.",
    });
  });

  test("delivers scheduled task output and records task memory", async () => {
    const adapter = MessagingAdapter.instance as unknown as TMessagingAdapterInternals;
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    const saveMock = mockMemoryInstance();
    const runAssistantToolLoopMock = mock(async () => ({
      conversation: [],
      toolActivity: [],
      finalResponse: "Fresh task result.",
      stopReason: EAssistantLoopStopReason.FinalResponse,
      iterations: 1,
    }));

    adapter.transports.set(EMessagePlatform.Discord, {
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });
    adapter.ai = {
      runAssistantToolLoop: runAssistantToolLoopMock,
    };

    await adapter.handleCronFire(
      createCronContext({
        reminderFallbackText: undefined,
        taskPrompt: "Find fresh information.",
        taskFallbackText: "Task unavailable.",
      }),
    );

    expect(runAssistantToolLoopMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock).toHaveBeenCalledWith("user-1", "Fresh task result.");
    expect(saveMock).toHaveBeenCalledWith({
      chatId: "discord:user-1",
      author: ERole.Assistant,
      importance: EMemoryImportance.Low,
      message: "[CRON TASK study-checkin]: Fresh task result.",
    });
  });

  test("delivers and records the task fallback for an unusable result", async () => {
    const adapter = MessagingAdapter.instance as unknown as TMessagingAdapterInternals;
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    const saveMock = mockMemoryInstance();
    adapter.transports.set(EMessagePlatform.Discord, {
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });
    adapter.ai = {
      runAssistantToolLoop: mock(async () => ({
        conversation: [],
        toolActivity: [],
        finalResponse: "Partial output",
        stopReason: EAssistantLoopStopReason.OutputLimit,
        iterations: 1,
      })),
    };

    await adapter.handleCronFire(
      createCronContext({
        reminderFallbackText: undefined,
        taskPrompt: "Find fresh information.",
        taskFallbackText: "Task unavailable.",
      }),
    );

    expect(sendTextMock).toHaveBeenCalledWith("user-1", "Task unavailable.");
    expect(saveMock).toHaveBeenCalledWith({
      chatId: "discord:user-1",
      author: ERole.Assistant,
      importance: EMemoryImportance.Low,
      message: "[CRON TASK study-checkin]: Task unavailable.",
    });
  });

  test("skips overlapping runs of the same scoped task", async () => {
    const adapter = MessagingAdapter.instance as unknown as TMessagingAdapterInternals;
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runAssistantToolLoopMock = mock(async () => {
      await pending;
      return {
        conversation: [],
        toolActivity: [],
        finalResponse: "Fresh task result.",
        stopReason: EAssistantLoopStopReason.FinalResponse,
        iterations: 1,
      };
    });
    mockMemoryInstance();
    adapter.transports.set(EMessagePlatform.Discord, {
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });
    adapter.ai = { runAssistantToolLoop: runAssistantToolLoopMock };
    const context = createCronContext({
      reminderFallbackText: undefined,
      taskPrompt: "Find fresh information.",
      taskFallbackText: "Task unavailable.",
    });

    const first = adapter.handleCronFire(context);
    await Promise.resolve();
    await adapter.handleCronFire(context);
    release();
    await first;

    expect(runAssistantToolLoopMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock).toHaveBeenCalledTimes(1);
  });

  test("releases the task overlap guard after a failed run", async () => {
    const adapter = MessagingAdapter.instance as unknown as TMessagingAdapterInternals;
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    const runAssistantToolLoopMock = mock(async () => {
      throw new Error("provider failed");
    });
    mockMemoryInstance();
    adapter.transports.set(EMessagePlatform.Discord, {
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });
    adapter.ai = { runAssistantToolLoop: runAssistantToolLoopMock };
    const context = createCronContext({
      reminderFallbackText: undefined,
      taskPrompt: "Find fresh information.",
      taskFallbackText: "Task unavailable.",
    });

    await adapter.handleCronFire(context);
    await adapter.handleCronFire(context);

    expect(runAssistantToolLoopMock).toHaveBeenCalledTimes(2);
    expect(sendTextMock).toHaveBeenCalledTimes(2);
  });

  test("does not remember task text when delivery fails", async () => {
    const adapter = MessagingAdapter.instance as unknown as TMessagingAdapterInternals;
    const sendTextMock = mock(async () => {
      throw new Error("send failed");
    });
    const saveMock = mockMemoryInstance();
    adapter.transports.set(EMessagePlatform.Discord, {
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });
    adapter.ai = {
      runAssistantToolLoop: mock(async () => ({
        conversation: [],
        toolActivity: [],
        finalResponse: "Fresh task result.",
        stopReason: EAssistantLoopStopReason.FinalResponse,
        iterations: 1,
      })),
    };

    await adapter.handleCronFire(
      createCronContext({
        reminderFallbackText: undefined,
        taskPrompt: "Find fresh information.",
        taskFallbackText: "Task unavailable.",
      }),
    );

    expect(saveMock).toHaveBeenCalledTimes(0);
  });

  test("skips blank cron reminder text", async () => {
    const adapter = MessagingAdapter.instance as unknown as TMessagingAdapterInternals;
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    const saveMock = mockMemoryInstance();

    adapter.transports.set(EMessagePlatform.Discord, {
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });

    await adapter.handleCronFire(
      createCronContext({
        reminderText: "   ",
        reminderFallbackText: undefined,
      }),
    );

    expect(sendTextMock).toHaveBeenCalledTimes(0);
    expect(saveMock).toHaveBeenCalledTimes(0);
  });

  test("skips signal cron reminders when no Signal transport is registered", async () => {
    const adapter = MessagingAdapter.instance as unknown as TMessagingAdapterInternals;
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});

    adapter.transports.set(EMessagePlatform.Discord, {
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });

    await adapter.handleCronFire(
      createCronContext({
        scope: "signal:signal-chat-1",
        reminderText: "Reminder text.",
      }),
    );

    expect(sendTextMock).toHaveBeenCalledTimes(0);
  });

  test("skips invalid cron scopes", async () => {
    const adapter = MessagingAdapter.instance as unknown as TMessagingAdapterInternals;
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});

    adapter.transports.set(EMessagePlatform.Discord, {
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });

    await adapter.handleCronFire(
      createCronContext({
        scope: "user-1",
        reminderText: "Reminder text.",
      }),
    );

    expect(sendTextMock).toHaveBeenCalledTimes(0);
  });

  test("falls back when generated reminder text is empty", async () => {
    const adapter = MessagingAdapter.instance as unknown as TMessagingAdapterInternals;
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    const runToolTaskMock = mock(async () => ({
      assistantResponse: "   ",
      toolCalls: [],
      toolResults: [],
    }));

    mockMemoryInstance();
    adapter.transports.set(EMessagePlatform.Discord, {
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });
    adapter.ai = {
      runToolTask: runToolTaskMock,
    };

    await adapter.handleCronFire(
      createCronContext({
        reminderPromptData: '{"topic":"study","tone":"encouraging"}',
        reminderFallbackText: "Fallback reminder.",
      }),
    );

    expect(runToolTaskMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock).toHaveBeenCalledWith("user-1", "Fallback reminder.");
  });

  test("falls back when direct reminder text is blank", async () => {
    const adapter = MessagingAdapter.instance as unknown as TMessagingAdapterInternals;
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    const runToolTaskMock = mock(async () => ({
      assistantResponse: "should not be used",
      toolCalls: [],
      toolResults: [],
    }));

    mockMemoryInstance();
    adapter.transports.set(EMessagePlatform.Discord, {
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });
    adapter.ai = {
      runToolTask: runToolTaskMock,
    };

    await adapter.handleCronFire(
      createCronContext({
        reminderText: "   ",
        reminderFallbackText: "Fallback reminder.",
      }),
    );

    expect(runToolTaskMock).toHaveBeenCalledTimes(0);
    expect(sendTextMock).toHaveBeenCalledWith("user-1", "Fallback reminder.");
  });

  test("routes settings-intent messages to SettingsMessageHandler", async () => {
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    const adapter = MessagingAdapter.instance;
    const settingsHandleMessageMock = mock(async () => "settings reply");
    const normalHandleMessageMock = mock(async () => "normal reply");

    mockClassifierIntent({ intent: "settings", reason: "change timezone" });

    (
      SettingsMessageHandler as unknown as {
        _instances: Map<string, { handleMessage: typeof settingsHandleMessageMock }>;
      }
    )._instances.set("discord:user-1", {
      handleMessage: settingsHandleMessageMock,
    });
    (
      MessageHandler as unknown as {
        _instances: Map<string, { handleMessage: typeof normalHandleMessageMock }>;
      }
    )._instances.set("discord:user-1", {
      handleMessage: normalHandleMessageMock,
    });

    adapter.registerTransport({
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });

    await adapter.handleInboundMessage({
      platform: EMessagePlatform.Discord,
      chatId: "user-1",
      author: {
        id: "user-1",
        username: "TestUser",
      },
      message: {
        type: "text",
        content: "change your timezone to UTC",
      },
    });

    expect(settingsHandleMessageMock).toHaveBeenCalledTimes(1);
    expect(normalHandleMessageMock).toHaveBeenCalledTimes(0);
    expect(sendTextMock).toHaveBeenCalledWith("user-1", "settings reply");
  });

  test("routes normal-intent messages to MessageHandler", async () => {
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    const adapter = MessagingAdapter.instance;
    const settingsHandleMessageMock = mock(async () => "settings reply");
    const normalHandleMessageMock = mock(async () => "normal reply");

    mockClassifierIntent({ intent: "normal", reason: "casual greeting" });

    (
      SettingsMessageHandler as unknown as {
        _instances: Map<string, { handleMessage: typeof settingsHandleMessageMock }>;
      }
    )._instances.set("discord:user-1", {
      handleMessage: settingsHandleMessageMock,
    });
    (
      MessageHandler as unknown as {
        _instances: Map<string, { handleMessage: typeof normalHandleMessageMock }>;
      }
    )._instances.set("discord:user-1", {
      handleMessage: normalHandleMessageMock,
    });

    adapter.registerTransport({
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });

    await adapter.handleInboundMessage({
      platform: EMessagePlatform.Discord,
      chatId: "user-1",
      author: {
        id: "user-1",
        username: "TestUser",
      },
      message: {
        type: "text",
        content: "hello",
      },
    });

    expect(normalHandleMessageMock).toHaveBeenCalledTimes(1);
    expect(settingsHandleMessageMock).toHaveBeenCalledTimes(0);
    expect(sendTextMock).toHaveBeenCalledWith("user-1", "normal reply");
  });

  test("falls back to MessageHandler when classifier returns no result", async () => {
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    const adapter = MessagingAdapter.instance;
    const settingsHandleMessageMock = mock(async () => "settings reply");
    const normalHandleMessageMock = mock(async () => "normal reply");

    mockClassifierIntent(undefined);

    (
      SettingsMessageHandler as unknown as {
        _instances: Map<string, { handleMessage: typeof settingsHandleMessageMock }>;
      }
    )._instances.set("discord:user-1", {
      handleMessage: settingsHandleMessageMock,
    });
    (
      MessageHandler as unknown as {
        _instances: Map<string, { handleMessage: typeof normalHandleMessageMock }>;
      }
    )._instances.set("discord:user-1", {
      handleMessage: normalHandleMessageMock,
    });

    adapter.registerTransport({
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });

    await adapter.handleInboundMessage({
      platform: EMessagePlatform.Discord,
      chatId: "user-1",
      author: {
        id: "user-1",
        username: "TestUser",
      },
      message: {
        type: "text",
        content: "hello",
      },
    });

    expect(normalHandleMessageMock).toHaveBeenCalledTimes(1);
    expect(settingsHandleMessageMock).toHaveBeenCalledTimes(0);
    expect(sendTextMock).toHaveBeenCalledWith("user-1", "normal reply");
  });

  test("does not invoke normal handler for mixed settings+task classified as settings", async () => {
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    const adapter = MessagingAdapter.instance;
    const settingsHandleMessageMock = mock(async () => "settings reply");
    const normalHandleMessageMock = mock(async () => "normal reply");

    mockClassifierIntent({ intent: "settings", reason: "mixed settings + task" });

    (
      SettingsMessageHandler as unknown as {
        _instances: Map<string, { handleMessage: typeof settingsHandleMessageMock }>;
      }
    )._instances.set("discord:user-1", {
      handleMessage: settingsHandleMessageMock,
    });
    (
      MessageHandler as unknown as {
        _instances: Map<string, { handleMessage: typeof normalHandleMessageMock }>;
      }
    )._instances.set("discord:user-1", {
      handleMessage: normalHandleMessageMock,
    });

    adapter.registerTransport({
      platform: EMessagePlatform.Discord,
      sendText: sendTextMock,
    });

    await adapter.handleInboundMessage({
      platform: EMessagePlatform.Discord,
      chatId: "user-1",
      author: {
        id: "user-1",
        username: "TestUser",
      },
      message: {
        type: "text",
        content: "remind me to call mom and change your timezone to UTC",
      },
    });

    expect(settingsHandleMessageMock).toHaveBeenCalledTimes(1);
    expect(normalHandleMessageMock).toHaveBeenCalledTimes(0);
    expect(sendTextMock).toHaveBeenCalledWith("user-1", "settings reply");
  });
});
