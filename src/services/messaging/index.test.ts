import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ECronEngineJobType, type TCronEngineJobContext } from "../../lib/cron-engine";
import { ERole } from "../ai/types";
import { CronSingleton } from "../cron";
import { Memory } from "../memory";
import { EMemoryImportance } from "../memory/types";
import { MessageHandler } from "../message-handler";
import { MessagingAdapter } from "./index";
import { EMessagePlatform, type TMessageTransport } from "./types";

type TMessagingAdapterStatic = {
  _instance: MessagingAdapter | undefined;
};

type TMessagingAdapterInternals = {
  ai: {
    runToolTask: typeof import("../ai/api").AiConnector.prototype.runToolTask;
  };
  transports: Map<EMessagePlatform, TMessageTransport>;
  handleCronFire: (ctx: TCronEngineJobContext) => Promise<void>;
};

type TCronSingletonStatic = {
  _instance: CronSingleton | undefined;
};

type TMemoryStatic = {
  _instance: Memory | undefined;
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
}

function createTransport(platform: EMessagePlatform) {
  const sendText = mock(async () => {});
  const transport: TMessageTransport = {
    platform,
    sendText,
  };

  return { transport, sendText };
}

function createCronContext(overrides: Partial<TCronEngineJobContext> = {}): TCronEngineJobContext {
  const now = new Date("2026-01-01T00:00:00.000Z");

  return {
    name: "study-checkin",
    scope: "discord:user-1",
    group: undefined,
    type: ECronEngineJobType.Recurring,
    pattern: "*/30 * * * *",
    nextRunAt: now,
    lastRunAt: undefined,
    reminderText: undefined,
    reminderPromptData: undefined,
    reminderFallbackText: "Fallback reminder.",
    createdAt: now,
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

    expect(handleMessageMock).toHaveBeenCalledWith({
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
    });
    expect(sendTextMock).toHaveBeenCalledWith("user-1", "test response");
  });

  test("does not send empty assistant replies", async () => {
    const sendTextMock = mock(async (_chatId: string, _text: string) => {});
    const adapter = MessagingAdapter.instance;
    const handleMessageMock = mock(async () => "   ");

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
});
