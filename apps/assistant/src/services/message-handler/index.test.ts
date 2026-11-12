import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { and, asc, eq } from "drizzle-orm";
import { AgentHarness } from "../ai/agent-harness";
import { setupAiAuth } from "../ai/auth";
import { aiCredentials, aiModels } from "../ai/providers/registry";
import { EAiProvider, ERole } from "../ai/types";
import { ConversationStore } from "../conversation";
import type { TConversation } from "../conversation/types";
import { DatabaseConnector, type TDatabaseHandle } from "../database";
import {
  eventDeliveriesTable,
  eventsTable,
  memoriesTable,
  type TSelectMemory,
} from "../database/schema";
import { resetEventTables } from "../database/test-utils";
import { EventBus } from "../events";
import { EEventType } from "../events/catalog";
import { FactDistiller } from "../memory/distill";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord, EConfigKey } from "../settings/schema";
import { MessageHandler } from ".";

const TEST_TRACE: TBehaviorTraceContext = {
  turnId: "test",
  chatId: undefined,
  platform: undefined,
};

type THandlerInternals = {
  ai: {
    runMain: ReturnType<typeof mock>;
    compactConversation: ReturnType<typeof mock>;
  };
  conversations: ReturnType<typeof mockConversationStore>;
};

type TDistillerInternals = {
  processWindow: ReturnType<typeof mock>;
};

type TMemoryStub = {
  loadLiveFactWindow: ReturnType<typeof mock>;
  commitLiveFactWindow: ReturnType<typeof mock>;
};

function reset() {
  Object.assign(EventBus, { _instance: undefined });
  Object.assign(MessageHandler, { _instance: undefined });
  Object.assign(MessagingAdapter, { _instance: undefined });
  (SettingsService as unknown as { _instance: unknown })._instance = undefined;
  (FactDistiller as unknown as { _instance: unknown })._instance = undefined;
}

// Fact drains run in the FactDistiller singleton; point it at a memory stub.
function wireFactDistiller(memory: TMemoryStub) {
  const distiller = FactDistiller.instance as unknown as TDistillerInternals & {
    memory: TMemoryStub;
  };
  distiller.memory = memory;
  distiller.processWindow = mock(async () => undefined);
  return distiller;
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
        message: `Invented fact ${id}`,
        modelMessage: null,
        kind: "message",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ],
  };
}

function mockConversationStore() {
  let state: TConversation | undefined;
  return {
    load: mock(async () => structuredClone(state)),
    saveUserMessage: mock(
      async (
        _db: TDatabaseHandle,
        chatId: string,
        author: ERole,
        message: string,
        createdAt: Date,
      ): Promise<TSelectMemory> => ({
        id: 100,
        chatId,
        author,
        message,
        modelMessage: null,
        kind: "message",
        createdAt,
      }),
    ),
    saveTurn: mock(
      async (
        _db: TDatabaseHandle,
        _chatId: string,
        messages: Message[],
        _userId?: number,
        previous?: TConversation,
      ) => {
        state = structuredClone({
          summary: "",
          summaryTimestamp: 0,
          summarizedThroughId: 0,
          ...previous,
          entries: messages.map((message, index) => ({ id: index + 1, message })),
        });
        return state;
      },
    ),
    saveSummary: mock(async (_chatId: string, next: TConversation) => {
      state = structuredClone(next);
      return state;
    }),
  };
}

function finalResponse(text: string) {
  return {
    text,
    iterations: 1,
    toolCallCount: 0,
    stopReason: "completed",
    messages: [],
  };
}

// the conversation and memory consumers on a fresh bus
async function setupHandler(chatId: string, response = "Final answer") {
  const settings = structuredClone(DefaultConfigRecord);
  (SettingsService as unknown as { _instance: unknown })._instance = {
    getAll: mock(async () => settings),
  };
  const handler = MessageHandler.instance;
  const internals = handler as unknown as THandlerInternals;
  internals.conversations = mockConversationStore();
  const memory: TMemoryStub = {
    loadLiveFactWindow: mock(async () => emptyWindow(chatId)),
    commitLiveFactWindow: mock(async () => ({ committed: true, facts: [] })),
  };
  const distiller = wireFactDistiller(memory);
  internals.ai = {
    compactConversation: mock(async () => undefined),
    runMain: mock(async () => finalResponse(response)),
  };
  handler.setup();
  FactDistiller.instance.setup();
  setupAiAuth();
  await EventBus.instance.start();
  return { handler, internals, settings, memory, distiller };
}

function requestTurn(chatId: string, content: string, receivedAt = Date.now()) {
  return EventBus.instance.publish({
    type: EEventType.TurnRequested,
    source: "test",
    key: chatId,
    trace: { ...TEST_TRACE, chatId },
    payload: { chatId, content, receivedAt, platform: EMessagePlatform.Discord },
    causationId: undefined,
    dedupeKey: undefined,
  });
}

async function turn(chatId: string, content: string, receivedAt = Date.now()) {
  await requestTurn(chatId, content, receivedAt);
  await EventBus.instance.idle();
}

async function payloadsOf(type: EEventType) {
  const rows = await DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, type))
    .orderBy(asc(eventsTable.seq));
  return rows.map((row) => row.payload);
}

async function deliveryStatus(type: EEventType, consumer: string) {
  const rows = await DatabaseConnector.instance.database
    .select({ status: eventDeliveriesTable.status })
    .from(eventDeliveriesTable)
    .innerJoin(eventsTable, eq(eventsTable.seq, eventDeliveriesTable.eventSeq))
    .where(and(eq(eventsTable.type, type), eq(eventDeliveriesTable.consumer, consumer)))
    .orderBy(asc(eventsTable.seq));
  return rows.map((row) => row.status);
}

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(condition: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) {
      return;
    }

    await Bun.sleep(1);
  }

  throw new Error("Condition was not met");
}

function waitForCall(mockFunction: ReturnType<typeof mock>, count: number) {
  return waitFor(() => mockFunction.mock.calls.length >= count);
}

beforeEach(async () => {
  reset();
  await resetEventTables();
});

afterEach(async () => {
  await EventBus.instance.stop();
  reset();
});

describe("MessageHandler", () => {
  test("preserves arrival timestamps while queued compaction crosses local midnight", async () => {
    const chatId = "discord:midnight-arrival";
    const { internals, settings } = await setupHandler(chatId);
    settings[EConfigKey.AiInstructionsTimezone] = "Europe/Warsaw";
    const store = ConversationStore.instance;
    internals.conversations.saveUserMessage = mock(
      (...args: Parameters<typeof store.saveUserMessage>) => store.saveUserMessage(...args),
    );
    await internals.conversations.saveTurn(DatabaseConnector.instance.database, chatId, []);
    const firstArrival = new Date("2026-07-24T21:59:50.000Z");
    const secondArrival = new Date("2026-07-24T21:59:55.000Z");
    const processingTime = new Date("2026-07-24T22:00:10.000Z");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstCompaction = true;
    internals.ai.compactConversation = mock(async () => {
      if (firstCompaction) {
        firstCompaction = false;
        await gate;
      }
      return undefined;
    });

    setSystemTime(firstArrival);
    try {
      await requestTurn(chatId, "What is on my calendar tomorrow?", firstArrival.getTime());
      await waitForCall(internals.ai.compactConversation, 1);
      await requestTurn(chatId, "And tomorrow evening?", secondArrival.getTime());
      setSystemTime(processingTime);
      release();
      await EventBus.instance.idle();

      expect(internals.ai.runMain.mock.calls[0]?.[0].currentTimeContext).toContain(
        "UTC: 2026-07-24T21:59:50.000Z",
      );
      expect(internals.ai.runMain.mock.calls[0]?.[0].currentTimeContext).toContain(
        "Local: 2026-07-24 23:59:50",
      );
      expect(internals.ai.runMain.mock.calls[1]?.[0].currentTimeContext).toContain(
        "Local: 2026-07-24 23:59:55",
      );
      const persisted = await DatabaseConnector.instance.database
        .select()
        .from(memoriesTable)
        .where(eq(memoriesTable.chatId, chatId))
        .orderBy(asc(memoriesTable.id));
      expect(persisted.map((message) => message.createdAt)).toEqual([firstArrival, secondArrival]);
    } finally {
      release();
      setSystemTime();
    }
  });

  test("reuses the previous request prefix with persisted message times across days", async () => {
    const chatId = "discord:cache-prefix";
    const { internals, settings } = await setupHandler(chatId);
    settings[EConfigKey.AiProvider] = EAiProvider.Openrouter;
    settings[EConfigKey.AiInstructionsTimezone] = "Europe/Warsaw";
    const previousApiKey = Bun.env.OPENROUTER_API_KEY;
    const previousProvider = aiModels.getProvider(EAiProvider.Openrouter);
    Bun.env.OPENROUTER_API_KEY = "cache-test-key";
    const faux = fauxProvider({
      provider: EAiProvider.Openrouter,
      models: [{ id: "google/gemini-3.1-pro-preview", reasoning: true }],
    });
    const requests: Array<{ context: TranscriptContext; model: Model<string> }> = [];
    faux.setResponses([
      (context, _options, _state, model) => {
        requests.push({
          context: {
            ...context,
            messages: structuredClone(context.messages),
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
          },
          model,
        });
        return fauxAssistantMessage("Second reply");
      },
    ]);
    aiModels.setProvider(faux.provider);
    const saved: TSelectMemory[] = [];
    let savedAt = new Date("2026-09-10T10:00:00.123Z");
    internals.conversations.saveUserMessage = mock(
      async (_db: TDatabaseHandle, chatId: string, author: ERole, message: string) => {
        const row: TSelectMemory = {
          id: saved.length + 1,
          chatId,
          author,
          message,
          modelMessage: null,
          kind: "message",
          createdAt: savedAt,
        };
        saved.push(row);
        return row;
      },
    );
    internals.ai.runMain = mock((args) => AgentHarness.instance.runMain(args));

    try {
      await turn(chatId, "What day is tomorrow?", savedAt.getTime());
      savedAt = new Date("2026-09-11T11:00:00.456Z");
      await turn(chatId, "And today?", savedAt.getTime());

      expect(requests).toHaveLength(2);
      const [first, second] = requests;
      if (first === undefined || second === undefined) {
        throw new Error("Expected two captured requests");
      }
      expect(getCurrentSystemPrompt(second.context.messages)).toBe(
        getCurrentSystemPrompt(first.context.messages),
      );
      expect(getCurrentTools(second.context.messages)).toEqual(
        getCurrentTools(first.context.messages),
      );
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

  test("reply.ready commits before compaction ends, and the next turn.requested starts after it", async () => {
    const chatId = "discord:compaction-order";
    const { internals } = await setupHandler(chatId);
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

    await requestTurn(chatId, "first");
    await waitForCall(internals.ai.compactConversation, 1);
    expect(await payloadsOf(EEventType.ReplyReady)).toEqual([{ chatId, text: "Final answer" }]);
    expect(await deliveryStatus(EEventType.TurnRequested, "conversation")).toEqual(["done"]);

    await requestTurn(chatId, "second");
    await flushAsyncWork();
    expect(internals.ai.runMain).toHaveBeenCalledTimes(1);
    release();
    await EventBus.instance.idle();
    expect(internals.ai.runMain.mock.calls[1]?.[0].conversation.summary).toBe("We chose the train");
  });

  test("keeps original context if saving the summary fails and retries before the next turn", async () => {
    const chatId = "discord:compaction-retry";
    const { internals } = await setupHandler(chatId);
    internals.ai.compactConversation = mock(async (state) => ({
      state: { ...state, summary: "compact summary", summaryTimestamp: 1 },
      usage: {},
    }));
    internals.conversations.saveSummary.mockImplementationOnce(async () => {
      throw new Error("summary write failed");
    });

    await turn(chatId, "first");
    expect(internals.conversations.saveSummary).toHaveBeenCalledTimes(1);
    expect((await internals.conversations.load())?.summary).toBe("");
    await turn(chatId, "first");
    expect(internals.ai.runMain.mock.calls[1]?.[0].conversation.summary).toBe("compact summary");
  });

  test("takes an immutable settings snapshot", async () => {
    const chatId = "signal:1";
    const { internals } = await setupHandler(chatId);
    const sharedSettings = structuredClone(DefaultConfigRecord);
    (SettingsService as unknown as { _instance: unknown })._instance = {
      getAll: mock(async () => ({ ...sharedSettings })),
    };
    let capturedSettings: typeof DefaultConfigRecord | undefined;
    internals.ai.runMain = mock(async (args) => {
      capturedSettings = args.settings;
      return finalResponse("Done");
    });

    await turn(chatId, "change my settings");
    sharedSettings[EConfigKey.AiInstructionsTimezone] = "Asia/Tokyo";

    expect(capturedSettings).not.toBe(sharedSettings);
    expect(capturedSettings?.[EConfigKey.AiInstructionsTimezone]).toBe(
      DefaultConfigRecord[EConfigKey.AiInstructionsTimezone],
    );
    expect(internals.ai.runMain).toHaveBeenCalledTimes(1);
  });

  test("a failed user-message save publishes turn.failed and the failure reply, never a model reply", async () => {
    const chatId = "discord:user-save-failure";
    const { internals, memory } = await setupHandler(chatId);
    internals.conversations.saveUserMessage = mock(async () => {
      throw new Error("database unavailable");
    });

    await turn(chatId, "remember this");

    expect(internals.ai.runMain).not.toHaveBeenCalled();
    expect(internals.conversations.saveUserMessage).toHaveBeenCalledTimes(1);
    expect(await payloadsOf(EEventType.ReplyReady)).toEqual([
      { chatId, text: "Something went wrong." },
    ]);
    expect(await payloadsOf(EEventType.TurnFailed)).toEqual([{ chatId, reason: "error" }]);
    expect(await payloadsOf(EEventType.TurnStarted)).toEqual([]);
    expect(await payloadsOf(EEventType.TurnCompleted)).toEqual([]);
    expect(memory.loadLiveFactWindow).not.toHaveBeenCalled();
  });

  test("a failed turn save publishes turn.failed and the failure reply, never a model reply", async () => {
    const chatId = "discord:assistant-save-failure";
    const { internals, memory } = await setupHandler(chatId);
    internals.conversations.saveTurn = mock(async () => {
      throw new Error("database unavailable");
    });

    await turn(chatId, "hello");

    expect(await payloadsOf(EEventType.ReplyReady)).toEqual([
      { chatId, text: "Something went wrong." },
    ]);
    expect(await payloadsOf(EEventType.TurnFailed)).toEqual([{ chatId, reason: "error" }]);
    expect(await payloadsOf(EEventType.TurnCompleted)).toEqual([]);
    expect(await deliveryStatus(EEventType.TurnRequested, "conversation")).toEqual(["done"]);
    expect(memory.loadLiveFactWindow).not.toHaveBeenCalled();
  });

  test("turn.completed commits in the transaction that saves the turn", async () => {
    const chatId = "discord:ordering";
    const { internals, memory } = await setupHandler(chatId);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const saveTurn = internals.conversations.saveTurn;
    internals.conversations.saveTurn = mock(async (...args: Parameters<typeof saveTurn>) => {
      events.push("save-start");
      await gate;
      events.push("save-end");
      return saveTurn(...args);
    });
    memory.loadLiveFactWindow = mock(async () => {
      events.push("drain");
      return emptyWindow(chatId);
    });

    await requestTurn(chatId, "remember this");
    await waitForCall(internals.conversations.saveTurn, 1);
    await flushAsyncWork();
    expect(events).toEqual(["save-start"]);
    release();
    await EventBus.instance.idle();

    expect(events).toEqual(["save-start", "save-end", "drain"]);
    expect(await payloadsOf(EEventType.TurnCompleted)).toEqual([{ chatId, userMessageId: 100 }]);
  });

  test("a stalled memory lane does not delay the next reply", async () => {
    const chatId = "discord:stalled";
    const { memory } = await setupHandler(chatId);
    memory.loadLiveFactWindow = mock(() => new Promise(() => undefined));

    await requestTurn(chatId, "first");
    await waitForCall(memory.loadLiveFactWindow, 1);
    await requestTurn(chatId, "second");

    await waitFor(async () => (await payloadsOf(EEventType.ReplyReady)).length === 2);
    expect(await deliveryStatus(EEventType.TurnRequested, "conversation")).toEqual([
      "done",
      "done",
    ]);
  });

  test("drains contiguous live windows until caught up", async () => {
    const chatId = "discord:drain";
    const { memory, distiller } = await setupHandler(chatId);
    const windows = [
      populatedWindow(chatId, 1),
      populatedWindow(chatId, 2),
      emptyWindow(chatId, 2),
    ];
    memory.loadLiveFactWindow = mock(async () => {
      const window = windows.shift();
      if (window === undefined) {
        throw new Error("Unexpected extra window load");
      }

      return window;
    });

    await turn(chatId, "two facts");

    expect(memory.loadLiveFactWindow).toHaveBeenCalledTimes(3);
    expect(distiller.processWindow).toHaveBeenCalledTimes(2);
    expect(distiller.processWindow.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        window: populatedWindow(chatId, 1),
      }),
    );
    expect(distiller.processWindow.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        window: populatedWindow(chatId, 2),
      }),
    );
  });

  test("a failed drain is acked and the next turn.completed retries the window", async () => {
    const chatId = "discord:retry";
    const { memory, distiller } = await setupHandler(chatId);
    const retryWindow = populatedWindow(chatId, 5);
    let loadCount = 0;
    memory.loadLiveFactWindow = mock(async () => {
      loadCount += 1;
      if (loadCount <= 2) {
        return retryWindow;
      }

      return emptyWindow(chatId, 5);
    });
    let processCount = 0;
    distiller.processWindow = mock(async () => {
      processCount += 1;
      if (processCount === 1) {
        throw new Error("embedding failed");
      }
    });

    await turn(chatId, "first turn");

    expect(memory.loadLiveFactWindow).toHaveBeenCalledTimes(1);
    expect(await deliveryStatus(EEventType.TurnCompleted, "memory")).toEqual(["done"]);

    await turn(chatId, "second turn");

    expect(memory.loadLiveFactWindow).toHaveBeenCalledTimes(3);
    expect(distiller.processWindow).toHaveBeenCalledTimes(2);
    expect(distiller.processWindow.mock.calls[0]?.[0].window).toEqual(retryWindow);
    expect(distiller.processWindow.mock.calls[1]?.[0].window).toEqual(retryWindow);
    expect(await deliveryStatus(EEventType.TurnCompleted, "memory")).toEqual(["done", "done"]);
  });

  test.each([
    "error",
    "aborted",
    "serialized-tool-call",
    "forced-finalization-failed",
  ])("does not persist or replay a rejected %s transcript", async (stopReason) => {
    await aiCredentials.modify(EAiProvider.OpencodeGo, async () => ({
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: Date.now() + 60 * 60 * 1000,
    }));
    const chatId = "discord:2";
    const { internals, memory } = await setupHandler(chatId, "unused");
    internals.ai.runMain = mock(async () => ({
      text: undefined,
      iterations: 1,
      toolCallCount: 0,
      stopReason,
      messages: [fauxAssistantMessage("rejected transcript")],
    }));

    await turn(chatId, "hello");

    expect(await payloadsOf(EEventType.ReplyReady)).toEqual([
      { chatId, text: "Something went wrong." },
    ]);
    expect(await payloadsOf(EEventType.TurnFailed)).toEqual([
      { chatId, reason: "no_final_response" },
    ]);
    expect(internals.conversations.saveUserMessage).toHaveBeenCalledTimes(1);
    expect(internals.conversations.saveTurn).not.toHaveBeenCalled();
    expect(await internals.conversations.load()).toBeUndefined();
    expect(memory.loadLiveFactWindow).not.toHaveBeenCalled();
    await turn(chatId, "try again");
    expect(internals.ai.runMain.mock.calls[1]?.[0].conversation).toBeUndefined();
    await aiCredentials.delete(EAiProvider.OpencodeGo);
  });

  test("replies with the login command when the selected provider is not connected", async () => {
    const chatId = "discord:3";
    const { internals } = await setupHandler(chatId, "unused");
    internals.ai.runMain = mock(async () => ({
      text: undefined,
      iterations: 1,
      toolCallCount: 0,
      stopReason: "error",
      messages: [],
    }));

    await turn(chatId, "hello");

    expect(await payloadsOf(EEventType.ReplyReady)).toEqual([
      { chatId, text: "opencode-go is not connected. Run !ai-auth login opencode-go." },
    ]);
  });

  test("a redelivered turn.requested with a stored turn.started sends the interrupted reply without the model", async () => {
    const chatId = `discord:interrupted-${crypto.randomUUID()}`;
    (SettingsService as unknown as { _instance: unknown })._instance = {
      getAll: mock(async () => DefaultConfigRecord),
    };
    const stalled = mock(() => new Promise(() => undefined));
    Object.assign(MessageHandler.instance, {
      ai: { runMain: stalled, compactConversation: mock(async () => undefined) },
    });
    MessageHandler.instance.setup();
    await EventBus.instance.start();
    await requestTurn(chatId, "book the flight");
    await waitForCall(stalled, 1);

    // restart: the stalled attempt dies with the old bus and handler
    await EventBus.instance.stop();
    reset();
    (SettingsService as unknown as { _instance: unknown })._instance = {
      getAll: mock(async () => DefaultConfigRecord),
    };
    const runMain = mock(async () => finalResponse("unused"));
    Object.assign(MessageHandler.instance, {
      ai: { runMain, compactConversation: mock(async () => undefined) },
    });
    const sendText = mock(async (_chatId: string, _text: string) => undefined);
    const adapter = MessagingAdapter.instance;
    Object.assign(adapter, { outboundBackoffMs: [] });
    adapter.registerTransport({ platform: EMessagePlatform.Discord, sendText });
    MessageHandler.instance.setup();
    adapter.setup();
    await EventBus.instance.start();
    await EventBus.instance.idle();

    const interrupted =
      "I was restarted while answering, so that reply is lost. Some actions may already be done. Check before asking again.";
    expect(runMain).not.toHaveBeenCalled();
    expect(sendText.mock.calls).toEqual([[chatId.slice("discord:".length), interrupted]]);
    expect(await payloadsOf(EEventType.TurnFailed)).toEqual([{ chatId, reason: "interrupted" }]);
    const memories = await DatabaseConnector.instance.database
      .select()
      .from(memoriesTable)
      .where(eq(memoriesTable.chatId, chatId))
      .orderBy(asc(memoriesTable.id));
    expect(memories.map((row) => row.message)).toEqual([
      "book the flight",
      expect.stringContaining("interrupted by a restart"),
      interrupted,
    ]);
  });

  test("two turns of one chat run in order while two chats overlap", async () => {
    const { internals } = await setupHandler("discord:a");
    const release = Promise.withResolvers<void>();
    internals.ai.runMain = mock(async (args: { prompt: string }) => {
      if (args.prompt === "a1") {
        await release.promise;
      }
      return finalResponse(`reply ${args.prompt}`);
    });

    await requestTurn("discord:a", "a1");
    await requestTurn("discord:a", "a2");
    await requestTurn("discord:b", "b1");
    await waitFor(async () => (await payloadsOf(EEventType.ReplyReady)).length === 1);

    expect(await payloadsOf(EEventType.ReplyReady)).toEqual([
      { chatId: "discord:b", text: "reply b1" },
    ]);
    expect(internals.ai.runMain.mock.calls.map((call) => call[0].prompt)).toEqual(["a1", "b1"]);

    release.resolve();
    await EventBus.instance.idle();
    expect(internals.ai.runMain.mock.calls.map((call) => call[0].prompt)).toEqual([
      "a1",
      "b1",
      "a2",
    ]);
    expect(await payloadsOf(EEventType.ReplyReady)).toEqual([
      { chatId: "discord:b", text: "reply b1" },
      { chatId: "discord:a", text: "reply a1" },
      { chatId: "discord:a", text: "reply a2" },
    ]);
  });
});
