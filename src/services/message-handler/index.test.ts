import { afterEach, describe, expect, mock, test } from "bun:test";
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
  };
  queue: {
    enqueue(callback: () => unknown): Promise<unknown>;
  };
};

function reset() {
  (MessageHandler as unknown as { _instances: Map<string, MessageHandler> })._instances.clear();
  (SettingsService as unknown as { _instance: unknown })._instance = undefined;
}

afterEach(reset);

describe("MessageHandler", () => {
  test("passes latest-30 chronological history and saves only root user/final messages", async () => {
    const settings = structuredClone(DefaultConfigRecord);
    const getAll = mock(async () => settings);
    (SettingsService as unknown as { _instance: unknown })._instance = {
      getAll,
    };
    const handler = MessageHandler.getInstance("discord:1");
    const internals = handler as unknown as THandlerInternals;
    const recent = Array.from({ length: 30 }, (_, index) => ({
      chatId: "discord:1",
      author: index % 2 === 0 ? ERole.User : ERole.Assistant,
      importance: EMemoryImportance.Low,
      message: `message-${29 - index}`,
      createdAt: new Date(),
      lastReadAt: new Date(),
    }));
    internals.memory = {
      findRecent: mock(async () => ({ success: true, data: recent })),
      save: mock(async (args) => args),
    };
    internals.queue = {
      enqueue: async (callback) => callback(),
    };
    internals.ai = {
      completeText: mock(async () => EMemoryImportance.Medium),
      runMain: mock(async () => ({
        text: "Final answer",
        iterations: 1,
        toolCallCount: 0,
        stopReason: "completed",
      })),
    };

    const incomingMessage = {
      chatId: "discord:1",
      message: { type: "text" as const, content: "new question" },
      author: { type: ERole.User as const, id: "1", username: "Owner" },
    };
    const result = await handler.handleMessage(incomingMessage, EMessagePlatform.Discord);

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
    expect(internals.memory.save).toHaveBeenCalledTimes(1);
    await handler.saveAssistantMessage(incomingMessage, result);
    expect(getAll).toHaveBeenCalledTimes(1);
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
  });

  test("takes an immutable settings snapshot and has no classifier routing path", async () => {
    const sharedSettings = structuredClone(DefaultConfigRecord);
    (SettingsService as unknown as { _instance: unknown })._instance = {
      getAll: mock(async () => sharedSettings),
    };
    const handler = MessageHandler.getInstance("signal:1");
    const internals = handler as unknown as THandlerInternals;
    internals.memory = {
      findRecent: mock(async () => ({ success: true, data: [] })),
      save: mock(async (args) => args),
    };
    internals.queue = { enqueue: async (callback) => callback() };
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

    expect(capturedSettings).not.toBe(sharedSettings);
    expect(capturedSettings?.[EConfigKey.AiInstructionsTimezone]).toBe(
      DefaultConfigRecord[EConfigKey.AiInstructionsTimezone],
    );
    expect(internals.ai.runMain).toHaveBeenCalledTimes(1);
  });

  test("rejects when the assistant message cannot be saved", async () => {
    (SettingsService as unknown as { _instance: unknown })._instance = {
      getAll: mock(async () => DefaultConfigRecord),
    };
    const handler = MessageHandler.getInstance("discord:save-failure");
    const internals = handler as unknown as THandlerInternals;
    internals.memory = {
      findRecent: mock(async () => ({ success: true, data: [] })),
      save: mock(async () => ({ operation: "write", error: "database unavailable" })),
    };
    internals.queue = { enqueue: async (callback) => callback() };
    internals.ai = {
      completeText: mock(async () => EMemoryImportance.Low),
      runMain: mock(async () => ({
        text: "unused",
        iterations: 1,
        toolCallCount: 0,
        stopReason: "completed",
      })),
    };

    await expect(
      handler.saveAssistantMessage(
        {
          chatId: "discord:save-failure",
          message: { type: "text", content: "question" },
          author: { type: ERole.User, id: "1", username: "Owner" },
        },
        "Delivered reply",
      ),
    ).rejects.toThrow("Failed to save assistant message");
  });

  test("returns the user fallback and does not save an assistant message for blank final output", async () => {
    (SettingsService as unknown as { _instance: unknown })._instance = {
      getAll: mock(async () => DefaultConfigRecord),
    };
    const handler = MessageHandler.getInstance("discord:2");
    const internals = handler as unknown as THandlerInternals;
    internals.memory = {
      findRecent: mock(async () => ({ success: true, data: [] })),
      save: mock(async (args) => args),
    };
    internals.queue = { enqueue: async (callback) => callback() };
    internals.ai = {
      completeText: mock(async () => EMemoryImportance.Low),
      runMain: mock(async () => ({
        text: undefined,
        iterations: 1,
        toolCallCount: 0,
        stopReason: "error",
      })),
    };

    expect(
      await handler.handleMessage({
        chatId: "discord:2",
        message: { type: "text", content: "hello" },
        author: { type: ERole.User, id: "2", username: "Owner" },
      }),
    ).toBe("Something went wrong.");
    expect(internals.memory.save).toHaveBeenCalledTimes(1);
  });
});
