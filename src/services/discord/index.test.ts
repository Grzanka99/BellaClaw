import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ECronEngineJobType, type TCronEngineJobContext } from "../../lib/cron-engine";
import { ERole } from "../ai/types";
import { CronSingleton } from "../cron";
import { resetCronEngineJobsTable } from "../database/test-utils";
import { Memory } from "../memory";
import { EMemoryImportance } from "../memory/types";
import { MessageHandler } from "../message-handler";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform, type TMessageTransport } from "../messaging/types";
import { DiscordSingleton } from "./index";

type TDiscordSingletonInternals = {
  client: {
    users: {
      fetch: (userId: string) => Promise<{
        send: (text: string) => Promise<void>;
      }>;
    };
  };
  handleMessage: (message: {
    author: { id: string; username: string };
    content: string;
  }) => Promise<void>;
  onReady: (client: { user: { tag: string } }) => Promise<void>;
};

type TDiscordSingletonStatic = {
  _instance: DiscordSingleton | undefined;
};

type TCronSingletonStatic = {
  _instance: CronSingleton | undefined;
};

type TMessagingAdapterInternals = {
  ai: {
    runToolTask: typeof import("../ai/api").AiConnector.prototype.runToolTask;
  };
  transports: Map<EMessagePlatform, TMessageTransport>;
  cronListenerRegistered: boolean;
  handleCronFire: (ctx: TCronEngineJobContext) => Promise<void>;
};

type TMessagingAdapterStatic = {
  _instance: MessagingAdapter | undefined;
};

function resetMemoryInstance() {
  const MemoryWithInternals = Memory as unknown as {
    _instance: { save: typeof Memory.prototype.save } | undefined;
  };

  MemoryWithInternals._instance = undefined;
}

function mockMemoryInstance() {
  const MemoryWithInternals = Memory as unknown as {
    _instance: { save: typeof Memory.prototype.save } | undefined;
  };

  MemoryWithInternals._instance = {
    save: mock(async () => ({
      chatId: "user-1",
      author: ERole.Assistant,
      importance: EMemoryImportance.Low,
      message: "Saved reminder",
      createdAt: new Date(),
      lastReadAt: new Date(),
    })),
  };
}

function cleanupSingletons() {
  const CronSingletonWithInternals = CronSingleton as unknown as TCronSingletonStatic;
  CronSingletonWithInternals._instance?.destroy();
  CronSingletonWithInternals._instance = undefined;

  const DiscordSingletonWithInternals = DiscordSingleton as unknown as TDiscordSingletonStatic;
  DiscordSingletonWithInternals._instance = undefined;

  const MessagingAdapterWithInternals = MessagingAdapter as unknown as TMessagingAdapterStatic;
  MessagingAdapterWithInternals._instance = undefined;

  (MessageHandler as unknown as { _instances: Map<string, MessageHandler> })._instances.clear();

  resetMemoryInstance();
}

function createCronContext(overrides: Partial<TCronEngineJobContext> = {}): TCronEngineJobContext {
  return {
    name: "study-checkin",
    scope: "discord:user-1",
    group: undefined,
    type: ECronEngineJobType.Recurring,
    pattern: "*/30 * * * *",
    reminderText: undefined,
    reminderPromptData: undefined,
    reminderFallbackText: "Fallback reminder.",
    lastRunAt: undefined,
    nextRunAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

describe("DiscordSingleton", () => {
  beforeEach(async () => {
    cleanupSingletons();
    await resetCronEngineJobsTable();
    mockMemoryInstance();
  });

  afterEach(() => {
    cleanupSingletons();
  });

  test("does not start cron after Discord client is ready", async () => {
    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    const cron = CronSingleton.instance as unknown as { setup: () => void };
    const setupMock = mock(() => {});

    cron.setup = setupMock;

    await discord.onReady({
      user: {
        tag: "BellaClaw#0001",
      },
    });

    expect(setupMock).toHaveBeenCalledTimes(0);
  });

  test("forwards inbound Discord messages to messaging adapter", async () => {
    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    const adapter = MessagingAdapter.instance as unknown as {
      handleInboundMessage: typeof MessagingAdapter.prototype.handleInboundMessage;
    };
    const handleInboundMessageMock = mock(async () => {});

    adapter.handleInboundMessage = handleInboundMessageMock;
    discord.client = {
      user: {
        id: "bot-1",
      },
      users: {
        fetch: mock(async () => ({
          send: mock(async () => {}),
        })),
      },
    } as never;

    await discord.handleMessage({
      author: {
        id: "user-1",
        username: "TestUser",
      },
      content: "hello",
    });

    expect(handleInboundMessageMock).toHaveBeenCalledWith({
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
  });
});

describe("MessagingAdapter", () => {
  beforeEach(async () => {
    cleanupSingletons();
    await resetCronEngineJobsTable();
    mockMemoryInstance();
  });

  afterEach(() => {
    cleanupSingletons();
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
    expect(Memory.instance.save).toHaveBeenCalledWith({
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
