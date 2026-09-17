import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TLogger } from "@bellaclaw/shared";
import {
  type Context,
  fauxAssistantMessage,
  fauxProvider,
  type Model,
} from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { AgentHarness } from "../ai/agent-harness";
import { aiModels } from "../ai/providers/registry";
import { EAiProvider, ERole } from "../ai/types";
import type { TConversation } from "../conversation/types";
import { Memory } from "../memory";
import { EMemoryImportance, type TMemory } from "../memory/types";
import { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord, EConfigKey } from "../settings/schema";
import { MessageHandler } from ".";
import type { TIncommingMessage } from "./types";

type THandlerInternals = {
  ai: {
    runMain: ReturnType<typeof mock>;
    compactConversation: ReturnType<typeof mock>;
  };
  conversations: ReturnType<typeof mockConversationStore>;
  memory: {
    findRecent: ReturnType<typeof mock>;
    save: ReturnType<typeof mock>;
    loadLiveFactWindow: ReturnType<typeof mock>;
    commitLiveFactWindow: ReturnType<typeof mock>;
  };
  factDistiller: {
    processWindow: ReturnType<typeof mock>;
  };
  logger: TLogger;
  queue: {
    enqueue(callback: () => Promise<unknown>): Promise<unknown>;
  };
};

function reset() {
  (MessageHandler as unknown as { _instances: Map<string, MessageHandler> })._instances.clear();
  (SettingsService as unknown as { _instance: unknown })._instance = undefined;
}

function emptyWindow(chatId: string, lastProcessedMessageId = 0) {
  return {
    state: {
      chatId,
      lastProcessedMessageId,
      updatedAt: undefined,
    },
    context: [],
    messages: [],
  };
}

function populatedWindow(chatId: string, id: number) {
  return {
    state: {
      chatId,
      lastProcessedMessageId: id - 1,
      updatedAt: undefined,
    },
    context: [],
    messages: [
      {
        id,
        chatId,
        author: ERole.User,
        importance: EMemoryImportance.Medium,
        message: `Invented fact ${id}`,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        lastReadAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ],
  };
}

function mockConversationStore() {
  let state: TConversation | undefined;
  return {
    load: mock(async () => structuredClone(state)),
    saveTurn: mock(async (_chatId: string, _platform: string, next: TConversation) => {
      state = structuredClone(next);
      return state;
    }),
    saveSummary: mock(async (_chatId: string, _platform: string, next: TConversation) => {
      state = structuredClone(next);
      return state;
    }),
  };
}

function setupHandler(chatId: string, response = "Final answer") {
  const settings = structuredClone(DefaultConfigRecord);
  (SettingsService as unknown as { _instance: unknown })._instance = {
    getAll: mock(async () => settings),
  };
  const handler = MessageHandler.getInstance(chatId);
  const internals = handler as unknown as THandlerInternals;
  internals.conversations = mockConversationStore();
  internals.memory = {
    findRecent: mock(async () => []),
    save: mock(async (args) => ({
      ...args,
      id: 100,
      createdAt: new Date(),
      lastReadAt: new Date(),
    })),
    loadLiveFactWindow: mock(async () => emptyWindow(chatId)),
    commitLiveFactWindow: mock(async () => ({ committed: true, facts: [] })),
  };
  internals.factDistiller = {
    processWindow: mock(async () => ({ success: true })),
  };
  internals.ai = {
    compactConversation: mock(async () => undefined),
    runMain: mock(async () => ({
      text: response,
      iterations: 1,
      toolCallCount: 0,
      stopReason: "completed",
      conversation: {
        messageIds: [],
        lastMemoryId: 0,
        summary: "",
        summaryTimestamp: 0,
        messages: [],
        fixedTokens: 0,
        contextTokens: 0,
      },
    })),
  };
  return { handler, internals, settings };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForCall(mockFunction: ReturnType<typeof mock>, count: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mockFunction.mock.calls.length >= count) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Expected mock to be called ${count} times`);
}

afterEach(reset);

describe("MessageHandler", () => {
  test("reuses the previous request prefix with persisted message times across days", async () => {
    const { handler, internals, settings } = setupHandler("discord:cache-prefix");
    settings[EConfigKey.AiProvider] = EAiProvider.Openrouter;
    settings[EConfigKey.AiInstructionsTimezone] = "Europe/Warsaw";
    const previousApiKey = Bun.env.OPENROUTER_API_KEY;
    const previousProvider = aiModels.getProvider(EAiProvider.Openrouter);
    Bun.env.OPENROUTER_API_KEY = "cache-test-key";
    const faux = fauxProvider({
      provider: EAiProvider.Openrouter,
      models: [{ id: "google/gemini-3.1-pro-preview", reasoning: true }],
    });
    const requests: Array<{ context: Context; model: Model<string> }> = [];
    faux.setResponses([
      (context, _options, _state, model) => {
        requests.push({
          context: {
            ...context,
            messages: structuredClone(context.messages),
            tools: context.tools?.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          },
          model,
        });
        return fauxAssistantMessage("First reply");
      },
      (context, _options, _state, model) => {
        requests.push({
          context: {
            ...context,
            messages: structuredClone(context.messages),
            tools: context.tools?.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          },
          model,
        });
        return fauxAssistantMessage("Second reply");
      },
    ]);
    aiModels.setProvider(faux.provider);
    const saved: TMemory[] = [];
    let savedAt = new Date("2026-09-10T10:00:00.123Z");
    internals.memory.save = mock(async (args) => {
      const message = {
        ...args,
        id: saved.length + 1,
        createdAt: savedAt,
        lastReadAt: savedAt,
      };
      saved.push(message);
      return message;
    });
    internals.memory.findRecent = mock(async () => saved.toReversed().slice(0, 30));
    internals.ai.runMain = mock((args) => AgentHarness.instance.runMain(args));

    try {
      await handler.handleMessage(
        {
          chatId: "discord:cache-prefix",
          message: { type: "text", content: "What day is tomorrow?" },
          author: { type: ERole.User, id: "1", username: "Owner" },
        },
        EMessagePlatform.Discord,
      );
      await flushAsyncWork();
      savedAt = new Date("2026-09-11T11:00:00.456Z");
      await handler.handleMessage(
        {
          chatId: "discord:cache-prefix",
          message: { type: "text", content: "And today?" },
          author: { type: ERole.User, id: "1", username: "Owner" },
        },
        EMessagePlatform.Discord,
      );
      await flushAsyncWork();

      expect(requests).toHaveLength(2);
      const [first, second] = requests;
      if (first === undefined || second === undefined) {
        throw new Error("Expected two captured requests");
      }
      expect(second.context.systemPrompt).toBe(first.context.systemPrompt);
      expect(second.context.tools).toEqual(first.context.tools);
      const firstInput = convertResponsesMessages(first.model, first.context, new Set());
      const secondInput = convertResponsesMessages(second.model, second.context, new Set());
      expect(secondInput.slice(0, firstInput.length)).toEqual(firstInput);
      expect(JSON.stringify(firstInput)).toContain("UTC: 2026-09-10T10:00:00.123Z");
      expect(JSON.stringify(secondInput)).toContain("UTC: 2026-09-11T11:00:00.456Z");
      expect(JSON.stringify(firstInput)).toContain("Local: 2026-09-10 12:00:00");
      expect(saved[0]?.message).toBe("What day is tomorrow?");
      expect(saved[1]?.message).toBe("And today?");
    } finally {
      if (previousProvider !== undefined) {
        aiModels.setProvider(previousProvider);
      }
      if (previousApiKey === undefined) {
        delete Bun.env.OPENROUTER_API_KEY;
      } else {
        Bun.env.OPENROUTER_API_KEY = previousApiKey;
      }
    }
  });

  test("bootstraps latest-30 chronological history and saves root transcripts as Medium", async () => {
    const { handler, internals } = setupHandler("discord:1");
    const recent = Array.from({ length: 30 }, (_, index) => ({
      chatId: "discord:1",
      platform: EMessagePlatform.Discord,
      author: index % 2 === 0 ? ERole.User : ERole.Assistant,
      importance: EMemoryImportance.Low,
      message: `message-${29 - index}`,
      createdAt: new Date(),
      lastReadAt: new Date(),
    }));
    internals.memory.findRecent = mock(async () => recent);

    const result = await handler.handleMessage(
      {
        chatId: "discord:1",
        message: { type: "text", content: "new question" },
        author: { type: ERole.User, id: "1", username: "Owner" },
      },
      EMessagePlatform.Discord,
    );
    await flushAsyncWork();

    expect(result).toBe("Final answer");
    expect(internals.memory.findRecent).toHaveBeenCalledWith(
      "discord:1",
      30,
      EMessagePlatform.Discord,
    );
    expect(internals.ai.runMain).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "new question",
        platform: EMessagePlatform.Discord,
        history: expect.arrayContaining([
          { role: ERole.Assistant, content: "message-0" },
          { role: ERole.User, content: expect.stringContaining("message-29") },
        ]),
      }),
    );
    const history = internals.ai.runMain.mock.calls[0]?.[0].history;
    expect(history[0]?.content).toBe("message-0");
    expect(history[29]?.content).toEndWith("\n\nmessage-29");
    expect(internals.memory.save).toHaveBeenCalledTimes(1);
    expect(internals.memory.save).toHaveBeenNthCalledWith(1, {
      chatId: "discord:1",
      platform: EMessagePlatform.Discord,
      author: ERole.User,
      importance: EMemoryImportance.Medium,
      message: "new question",
    });
    expect(internals.conversations.saveTurn).toHaveBeenCalledTimes(1);
  });

  test("returns the reply before compaction finishes and holds the next turn until it finishes", async () => {
    const { handler, internals } = setupHandler("compaction-order");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    internals.ai.compactConversation = mock(async (state) => {
      if (!first) {
        return undefined;
      }
      first = false;
      await gate;
      return { state: { ...state, summary: "We chose the train", summaryTimestamp: 1 }, usage: {} };
    });
    const message: TIncommingMessage = {
      chatId: "compaction-order",
      message: { type: "text" as const, content: "first" },
      author: { type: ERole.User, id: "1", username: "Owner" },
    };
    expect(await handler.handleMessage(message)).toBe("Final answer");
    await waitForCall(internals.ai.compactConversation, 1);
    const second = handler.handleMessage({
      ...message,
      message: { type: "text", content: "second" },
    });
    await flushAsyncWork();
    expect(internals.ai.runMain).toHaveBeenCalledTimes(1);
    release();
    await second;
    expect(internals.ai.runMain.mock.calls[1]?.[0].conversation.summary).toBe("We chose the train");
    expect(internals.memory.findRecent).toHaveBeenCalledTimes(1);
  });

  test("keeps original context if saving the summary fails and retries before the next turn", async () => {
    const { handler, internals } = setupHandler("compaction-retry");
    internals.ai.compactConversation = mock(async (state) => ({
      state: { ...state, summary: "compact summary", summaryTimestamp: 1 },
      usage: {},
    }));
    internals.conversations.saveSummary.mockImplementationOnce(async () => {
      throw new Error("summary write failed");
    });
    const message: TIncommingMessage = {
      chatId: "compaction-retry",
      message: { type: "text" as const, content: "first" },
      author: { type: ERole.User, id: "1", username: "Owner" },
    };
    await handler.handleMessage(message);
    await waitForCall(internals.conversations.saveSummary, 1);
    expect((await internals.conversations.load())?.summary).toBe("");
    await handler.handleMessage(message);
    expect(internals.ai.runMain.mock.calls[1]?.[0].conversation.summary).toBe("compact summary");
    await flushAsyncWork();
  });

  test("takes an immutable settings snapshot", async () => {
    const sharedSettings = structuredClone(DefaultConfigRecord);
    (SettingsService as unknown as { _instance: unknown })._instance = {
      getAll: mock(async () => ({ ...sharedSettings })),
    };
    const handler = MessageHandler.getInstance("signal:1");
    const internals = handler as unknown as THandlerInternals;
    internals.conversations = mockConversationStore();
    internals.memory = {
      findRecent: mock(async () => []),
      save: mock(async (args) => ({
        ...args,
        id: 100,
        createdAt: new Date(),
        lastReadAt: new Date(),
      })),
      loadLiveFactWindow: mock(async () => emptyWindow("signal:1")),
      commitLiveFactWindow: mock(async () => ({ committed: true, facts: [] })),
    };
    internals.factDistiller = {
      processWindow: mock(async () => ({ success: true })),
    };
    let capturedSettings: typeof DefaultConfigRecord | undefined;
    internals.ai = {
      compactConversation: mock(async () => undefined),
      runMain: mock(async (args) => {
        capturedSettings = args.settings;
        return {
          text: "Done",
          iterations: 1,
          toolCallCount: 0,
          stopReason: "completed",
          conversation: {
            messageIds: [],
            lastMemoryId: 0,
            summary: "",
            summaryTimestamp: 0,
            messages: [],
            fixedTokens: 0,
            contextTokens: 0,
          },
        };
      }),
    };

    await handler.handleMessage({
      chatId: "signal:1",
      message: { type: "text", content: "change my settings" },
      author: { type: ERole.User, id: "1", username: "Owner" },
    });
    sharedSettings[EConfigKey.AiInstructionsTimezone] = "Asia/Tokyo";
    await flushAsyncWork();

    expect(capturedSettings).not.toBe(sharedSettings);
    expect(capturedSettings?.[EConfigKey.AiInstructionsTimezone]).toBe(
      DefaultConfigRecord[EConfigKey.AiInstructionsTimezone],
    );
    expect(internals.ai.runMain).toHaveBeenCalledTimes(1);
  });

  test("stops before generating a reply when the user transcript cannot be saved", async () => {
    const { handler, internals } = setupHandler("discord:user-save-failure");
    internals.memory.save = mock(async () => {
      throw new Error("database unavailable");
    });

    await expect(
      handler.handleMessage({
        chatId: "discord:user-save-failure",
        message: { type: "text", content: "remember this" },
        author: { type: ERole.User, id: "1", username: "Owner" },
      }),
    ).rejects.toThrow("database unavailable");

    expect(internals.ai.runMain).not.toHaveBeenCalled();
    expect(internals.memory.save).toHaveBeenCalledTimes(1);
    expect(internals.memory.loadLiveFactWindow).not.toHaveBeenCalled();
  });

  test("fails without fact processing when the completed transcript cannot be saved", async () => {
    const { handler, internals } = setupHandler("discord:assistant-save-failure");
    internals.conversations.saveTurn = mock(async () => {
      throw new Error("database unavailable");
    });
    await expect(
      handler.handleMessage({
        chatId: "discord:assistant-save-failure",
        message: { type: "text", content: "hello" },
        author: { type: ERole.User, id: "1", username: "Owner" },
      }),
    ).rejects.toThrow("database unavailable");
    expect(internals.memory.loadLiveFactWindow).not.toHaveBeenCalled();
  });

  test("saves the main transcript before scheduling the fact drain", async () => {
    const { handler, internals } = setupHandler("discord:ordering");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    internals.conversations.saveTurn = mock(async (_chat, _platform, state) => {
      events.push("save-start");
      await gate;
      events.push("save-end");
      return state;
    });
    internals.memory.loadLiveFactWindow = mock(async () => {
      events.push("drain");
      return emptyWindow("discord:ordering");
    });
    const reply = handler.handleMessage({
      chatId: "discord:ordering",
      message: { type: "text", content: "remember this" },
      author: { type: ERole.User, id: "1", username: "Owner" },
    });
    await waitForCall(internals.conversations.saveTurn, 1);
    expect(events).toEqual(["save-start"]);
    release();
    await reply;
    await flushAsyncWork();
    expect(events).toEqual(["save-start", "save-end", "drain"]);
  });

  test("scheduleFactDrain catches up chats without an inbound message", async () => {
    const { handler, internals } = setupHandler("discord:boot");
    const windows = [populatedWindow("discord:boot", 1), emptyWindow("discord:boot", 1)];
    internals.memory.loadLiveFactWindow = mock(async () => windows.shift());

    handler.scheduleFactDrain(undefined);
    await waitForCall(internals.factDistiller.processWindow, 1);

    expect(internals.factDistiller.processWindow.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ window: populatedWindow("discord:boot", 1) }),
    );
    expect(internals.memory.save).not.toHaveBeenCalled();
  });

  test("a boot fact drain sweep never rejects when chat discovery fails", async () => {
    const memoryStatics = Memory as unknown as { _instance: unknown };
    const originalMemory = memoryStatics._instance;
    memoryStatics._instance = {
      findChatIds: mock(async () => {
        throw new Error("turso unreachable");
      }),
    };

    await expect(MessageHandler.scheduleFactDrainForAllChats("boot:1")).resolves.toBeUndefined();

    memoryStatics._instance = originalMemory;
  });

  test("a stalled fact drain does not delay the next reply", async () => {
    const { handler, internals } = setupHandler("discord:stalled");
    internals.memory.loadLiveFactWindow = mock(() => new Promise(() => undefined));

    await handler.handleMessage({
      chatId: "discord:stalled",
      message: { type: "text", content: "first" },
      author: { type: ERole.User, id: "1", username: "Owner" },
    });
    await waitForCall(internals.memory.loadLiveFactWindow, 1);

    const secondReply = await handler.handleMessage({
      chatId: "discord:stalled",
      message: { type: "text", content: "second" },
      author: { type: ERole.User, id: "1", username: "Owner" },
    });

    expect(secondReply).toBe("Final answer");
  });

  test("drains contiguous live windows until caught up", async () => {
    const { handler, internals } = setupHandler("discord:drain");
    const windows = [
      populatedWindow("discord:drain", 1),
      populatedWindow("discord:drain", 2),
      emptyWindow("discord:drain", 2),
    ];
    internals.memory.loadLiveFactWindow = mock(async () => {
      const window = windows.shift();
      if (window === undefined) {
        throw new Error("Unexpected extra window load");
      }

      return window;
    });

    await handler.handleMessage({
      chatId: "discord:drain",
      message: { type: "text", content: "two facts" },
      author: { type: ERole.User, id: "1", username: "Owner" },
    });
    await waitForCall(internals.memory.loadLiveFactWindow, 3);

    expect(internals.factDistiller.processWindow).toHaveBeenCalledTimes(2);
    expect(internals.factDistiller.processWindow.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        window: populatedWindow("discord:drain", 1),
      }),
    );
    expect(internals.factDistiller.processWindow.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        window: populatedWindow("discord:drain", 2),
      }),
    );
  });

  test("stops after a failed window and retries it on a later turn", async () => {
    const { handler, internals } = setupHandler("discord:retry");
    const retryWindow = populatedWindow("discord:retry", 5);
    let loadCount = 0;
    internals.memory.loadLiveFactWindow = mock(async () => {
      loadCount += 1;
      if (loadCount <= 2) {
        return retryWindow;
      }

      return emptyWindow("discord:retry", 5);
    });
    let processCount = 0;
    internals.factDistiller.processWindow = mock(async () => {
      processCount += 1;
      if (processCount === 1) {
        return { success: false as const, reason: "embedding" as const };
      }

      return { success: true as const };
    });

    await handler.handleMessage({
      chatId: "discord:retry",
      message: { type: "text", content: "first turn" },
      author: { type: ERole.User, id: "1", username: "Owner" },
    });
    await waitForCall(internals.factDistiller.processWindow, 1);
    await flushAsyncWork();

    expect(internals.memory.loadLiveFactWindow).toHaveBeenCalledTimes(1);

    await handler.handleMessage({
      chatId: "discord:retry",
      message: { type: "text", content: "second turn" },
      author: { type: ERole.User, id: "1", username: "Owner" },
    });
    await waitForCall(internals.memory.loadLiveFactWindow, 3);

    expect(internals.factDistiller.processWindow).toHaveBeenCalledTimes(2);
    expect(internals.factDistiller.processWindow.mock.calls[0]?.[0].window).toEqual(retryWindow);
    expect(internals.factDistiller.processWindow.mock.calls[1]?.[0].window).toEqual(retryWindow);
  });

  test("catches and logs a rejected compaction enqueue promise", async () => {
    const { handler, internals } = setupHandler("discord:queue-rejection");
    const logger = {
      info: mock(() => undefined),
      warning: mock(() => undefined),
      error: mock(() => undefined),
      message: mock(() => undefined),
    };
    internals.logger = logger as unknown as TLogger;
    let enqueueCount = 0;
    let tail = Promise.resolve<unknown>(undefined);
    internals.queue = {
      enqueue(callback) {
        enqueueCount += 1;
        if (enqueueCount === 3) {
          return Promise.reject(new Error("queue rejected compaction task"));
        }

        const task = tail.then(callback);
        tail = task.then(
          () => undefined,
          () => undefined,
        );
        return task;
      },
    };
    const unhandledRejection = mock(() => undefined);
    process.on("unhandledRejection", unhandledRejection);

    try {
      await handler.handleMessage({
        chatId: "discord:queue-rejection",
        message: { type: "text", content: "first turn" },
        author: { type: ERole.User, id: "1", username: "Owner" },
      });
      await flushAsyncWork();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("queue rejected compaction task"),
      );
      expect(unhandledRejection).not.toHaveBeenCalled();
      await handler.handleMessage({
        chatId: "discord:queue-rejection",
        message: { type: "text", content: "second turn" },
        author: { type: ERole.User, id: "1", username: "Owner" },
      });
      await waitForCall(internals.memory.loadLiveFactWindow, 1);

      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
  });

  test("returns the user fallback and does not save an assistant message for blank final output", async () => {
    const { handler, internals } = setupHandler("discord:2", "unused");
    internals.ai.runMain = mock(async () => ({
      text: undefined,
      iterations: 1,
      toolCallCount: 0,
      stopReason: "error",
      conversation: {
        messageIds: [],
        lastMemoryId: 0,
        summary: "",
        summaryTimestamp: 0,
        messages: [],
        fixedTokens: 0,
        contextTokens: 0,
      },
    }));

    expect(
      await handler.handleMessage({
        chatId: "discord:2",
        message: { type: "text", content: "hello" },
        author: { type: ERole.User, id: "2", username: "Owner" },
      }),
    ).toBe("Something went wrong.");
    await flushAsyncWork();

    expect(internals.memory.save).toHaveBeenCalledTimes(1);
    expect(internals.memory.loadLiveFactWindow).not.toHaveBeenCalled();
  });
});
