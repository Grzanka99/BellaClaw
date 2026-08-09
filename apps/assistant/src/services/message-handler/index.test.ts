import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TLogger } from "@bellaclaw/shared";
import { ERole } from "../ai/types";
import { EMemoryImportance } from "../memory/types";
import { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord, EConfigKey } from "../settings/schema";
import { MessageHandler } from ".";

type THandlerInternals = {
  ai: {
    completeText: ReturnType<typeof mock>;
    runMain: ReturnType<typeof mock>;
  };
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

function setupHandler(chatId: string, response = "Final answer") {
  const settings = structuredClone(DefaultConfigRecord);
  (SettingsService as unknown as { _instance: unknown })._instance = {
    getAll: mock(async () => settings),
  };
  const handler = MessageHandler.getInstance(chatId);
  const internals = handler as unknown as THandlerInternals;
  internals.memory = {
    findRecent: mock(async () => ({ success: true, data: [] })),
    save: mock(async (args) => args),
    loadLiveFactWindow: mock(async () => emptyWindow(chatId)),
    commitLiveFactWindow: mock(async () => ({ committed: true, facts: [] })),
  };
  internals.factDistiller = {
    processWindow: mock(async () => ({ success: true })),
  };
  internals.ai = {
    completeText: mock(async () => EMemoryImportance.Low),
    runMain: mock(async () => ({
      text: response,
      iterations: 1,
      toolCallCount: 0,
      stopReason: "completed",
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
  test("passes latest-30 chronological history and saves root transcripts as Medium", async () => {
    const { handler, internals } = setupHandler("discord:1");
    const recent = Array.from({ length: 30 }, (_, index) => ({
      chatId: "discord:1",
      author: index % 2 === 0 ? ERole.User : ERole.Assistant,
      importance: EMemoryImportance.Low,
      message: `message-${29 - index}`,
      createdAt: new Date(),
      lastReadAt: new Date(),
    }));
    internals.memory.findRecent = mock(async () => ({ success: true, data: recent }));

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
    expect(internals.memory.findRecent).toHaveBeenCalledWith("discord:1", 30);
    expect(internals.ai.runMain).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "new question",
        platform: EMessagePlatform.Discord,
        history: expect.arrayContaining([
          { role: ERole.Assistant, content: "message-0" },
          { role: ERole.User, content: "message-29" },
        ]),
      }),
    );
    const history = internals.ai.runMain.mock.calls[0]?.[0].history;
    expect(history[0]?.content).toBe("message-0");
    expect(history[29]?.content).toBe("message-29");
    expect(internals.memory.save).toHaveBeenCalledTimes(2);
    expect(internals.memory.save).toHaveBeenNthCalledWith(1, {
      chatId: "discord:1",
      author: ERole.User,
      importance: EMemoryImportance.Medium,
      message: "new question",
    });
    expect(internals.memory.save).toHaveBeenNthCalledWith(2, {
      chatId: "discord:1",
      author: ERole.Assistant,
      importance: EMemoryImportance.Medium,
      message: "Final answer",
    });
    expect(internals.ai.completeText).not.toHaveBeenCalled();
  });

  test("takes an immutable settings snapshot and has no importance classifier routing path", async () => {
    const sharedSettings = structuredClone(DefaultConfigRecord);
    (SettingsService as unknown as { _instance: unknown })._instance = {
      getAll: mock(async () => sharedSettings),
    };
    const handler = MessageHandler.getInstance("signal:1");
    const internals = handler as unknown as THandlerInternals;
    internals.memory = {
      findRecent: mock(async () => ({ success: true, data: [] })),
      save: mock(async (args) => args),
      loadLiveFactWindow: mock(async () => emptyWindow("signal:1")),
      commitLiveFactWindow: mock(async () => ({ committed: true, facts: [] })),
    };
    internals.factDistiller = {
      processWindow: mock(async () => ({ success: true })),
    };
    let capturedSettings: typeof DefaultConfigRecord | undefined;
    internals.ai = {
      completeText: mock(async () => EMemoryImportance.Low),
      runMain: mock(async (args) => {
        capturedSettings = args.settings;
        return {
          text: "Done",
          iterations: 1,
          toolCallCount: 0,
          stopReason: "completed",
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
    expect(internals.ai.completeText).not.toHaveBeenCalled();
  });

  test("stops before generating a reply when the user transcript cannot be saved", async () => {
    const { handler, internals } = setupHandler("discord:user-save-failure");
    internals.memory.save = mock(async () => ({
      operation: "write",
      error: "database unavailable",
    }));

    await expect(
      handler.handleMessage({
        chatId: "discord:user-save-failure",
        message: { type: "text", content: "remember this" },
        author: { type: ERole.User, id: "1", username: "Owner" },
      }),
    ).rejects.toThrow("Failed to save user transcript");

    expect(internals.ai.runMain).not.toHaveBeenCalled();
    expect(internals.memory.save).toHaveBeenCalledTimes(1);
    expect(internals.memory.loadLiveFactWindow).not.toHaveBeenCalled();
  });

  test("saves the assistant transcript before scheduling the live drain", async () => {
    const { handler, internals } = setupHandler("discord:ordering");
    let releaseAssistantSave: () => void = () => undefined;
    const assistantSaveGate = new Promise<void>((resolve) => {
      releaseAssistantSave = resolve;
    });
    const events: string[] = [];
    internals.memory.save = mock(async (args) => {
      if (args.author === ERole.Assistant) {
        events.push("assistant-save-start");
        await assistantSaveGate;
        events.push("assistant-save-end");
      }

      return args;
    });
    internals.memory.loadLiveFactWindow = mock(async () => {
      events.push("drain-load");
      return emptyWindow("discord:ordering");
    });

    await handler.handleMessage({
      chatId: "discord:ordering",
      message: { type: "text", content: "remember this" },
      author: { type: ERole.User, id: "1", username: "Owner" },
    });
    await waitForCall(internals.memory.save, 2);

    expect(events).toEqual(["assistant-save-start"]);
    expect(internals.memory.loadLiveFactWindow).not.toHaveBeenCalled();

    releaseAssistantSave();
    await waitForCall(internals.memory.loadLiveFactWindow, 1);

    expect(events).toEqual(["assistant-save-start", "assistant-save-end", "drain-load"]);
  });

  test("scheduleFactDrain catches up chats without an inbound message", async () => {
    const { handler, internals } = setupHandler("discord:boot");
    const windows = [populatedWindow("discord:boot", 1), emptyWindow("discord:boot", 1)];
    internals.memory.loadLiveFactWindow = mock(async () => windows.shift());

    handler.scheduleFactDrain();
    await waitForCall(internals.factDistiller.processWindow, 1);

    expect(internals.factDistiller.processWindow.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ window: populatedWindow("discord:boot", 1) }),
    );
    expect(internals.memory.save).not.toHaveBeenCalled();
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

  test("catches and logs a rejected fire-and-forget enqueue promise", async () => {
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
        if (enqueueCount === 2) {
          return Promise.reject(new Error("queue rejected assistant task"));
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
        expect.stringContaining("queue rejected assistant task"),
      );
      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(internals.memory.loadLiveFactWindow).not.toHaveBeenCalled();

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
