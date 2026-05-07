import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { ERole } from "../ai/types";
import { Memory, PERSISTENT_MEMORY_DB } from "./index";
import { EMemoryImportance } from "./types";

const TEST_DB = "test-memory.db";

function resetMemoryInstance(dbPath: string) {
  const MemoryWithPrivate = Memory as unknown as {
    _instance: Memory | undefined;
    MEMORY_FILE: string;
  };
  MemoryWithPrivate._instance = undefined;
  MemoryWithPrivate.MEMORY_FILE = dbPath;
}

describe("Memory", () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
    resetMemoryInstance(TEST_DB);
  });

  afterEach(() => {
    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
    resetMemoryInstance(PERSISTENT_MEMORY_DB);
  });

  describe("instance", () => {
    test("returns a Memory instance", () => {
      const instance = Memory.instance;
      expect(instance).toBeInstanceOf(Memory);
    });

    test("returns the same instance on multiple calls", () => {
      const instance1 = Memory.instance;
      const instance2 = Memory.instance;
      expect(instance1).toBe(instance2);
    });
  });

  describe("save", () => {
    test("saves a memory and returns the saved data", async () => {
      const memory = Memory.instance;
      const result = await memory.save({
        chatId: "chat-123",
        author: ERole.User,
        importance: EMemoryImportance.Medium,
        message: "Test memory",
      });

      expect(result).not.toHaveProperty("operation");
      expect(result).toEqual({
        chatId: "chat-123",
        author: ERole.User,
        importance: EMemoryImportance.Medium,
        message: "Test memory",
        createdAt: expect.any(Date),
        lastReadAt: expect.any(Date),
      });
    });

    test("sets createdAt and lastReadAt to the same timestamp", async () => {
      const memory = Memory.instance;
      const result = await memory.save({
        chatId: "chat-timestamp",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "Timestamp test",
      });

      if ("operation" in result) {
        throw new Error("Expected successful save");
      }
      expect(result.createdAt.getTime()).toBe(result.lastReadAt.getTime());
    });
  });

  describe("remove", () => {
    test("removes a memory and returns it", async () => {
      const memory = Memory.instance;
      await memory.save({
        chatId: "chat-remove",
        author: ERole.User,
        importance: EMemoryImportance.Medium,
        message: "Memory to remove",
      });

      const result = await memory.remove("1");

      expect(result).not.toHaveProperty("operation");
      expect(result).toEqual({
        id: 1,
        chatId: "chat-remove",
        author: ERole.User,
        importance: EMemoryImportance.Medium,
        message: "Memory to remove",
        createdAt: expect.any(Date),
        lastReadAt: expect.any(Date),
      });
    });

    test("returns error when memory not found", async () => {
      const memory = Memory.instance;
      const result = await memory.remove("999");

      expect(result).toHaveProperty("operation", "delete");
      expect(result).toHaveProperty("error", "No memory found with the given id");
    });
  });

  describe("readFullMemory", () => {
    test("returns all memories for a chat", async () => {
      const memory = Memory.instance;

      await memory.save({
        chatId: "chat-read",
        author: ERole.User,
        importance: EMemoryImportance.Medium,
        message: "First memory",
      });
      await memory.save({
        chatId: "chat-read",
        author: ERole.Assistant,
        importance: EMemoryImportance.High,
        message: "Second memory",
      });
      await memory.save({
        chatId: "chat-read",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "Third memory",
      });
      await memory.save({
        chatId: "chat-read",
        author: ERole.Assistant,
        importance: EMemoryImportance.Medium,
        message: "Fourth memory",
      });
      await memory.save({
        chatId: "chat-read",
        author: ERole.User,
        importance: EMemoryImportance.High,
        message: "Fifth memory",
      });

      const result = await memory.readFullMemory("chat-read");

      expect(result).toBeDefined();
      // @ts-expect-error
      expect(result?.length).toBe(5);

      // @ts-expect-error
      const messages = result.map((m) => m.message);
      expect(messages).toContain("First memory");
      expect(messages).toContain("Second memory");
      expect(messages).toContain("Third memory");
      expect(messages).toContain("Fourth memory");
      expect(messages).toContain("Fifth memory");
    });

    test("returns empty array when no memories exist for chat", async () => {
      const memory = Memory.instance;
      const result = await memory.readFullMemory("nonexistent-chat");

      expect(result).toEqual([]);
    });

    test("returns only memories for the specified chat", async () => {
      const memory = Memory.instance;

      await memory.save({
        chatId: "chat-a",
        author: ERole.User,
        importance: EMemoryImportance.Medium,
        message: "Chat A memory",
      });
      await memory.save({
        chatId: "chat-b",
        author: ERole.User,
        importance: EMemoryImportance.Medium,
        message: "Chat B memory",
      });

      const result = await memory.readFullMemory("chat-a");

      expect(result).toBeDefined();
      // @ts-expect-error
      expect(result?.length).toBe(1);
      // @ts-expect-error
      expect(result[0].message).toBe("Chat A memory");
      // @ts-expect-error
      expect(result[0].chatId).toBe("chat-a");
    });
  });

  describe("findRecent", () => {
    test("returns limited memories ordered by createdAt DESC", async () => {
      const memory = Memory.instance;
      for (let i = 0; i < 5; i++) {
        await memory.save({
          chatId: "chat-recent",
          author: ERole.User,
          importance: EMemoryImportance.Low,
          message: `Memory ${i}`,
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const result = await memory.findRecent("chat-recent", 3);

      expect(result.success).toBe(true);
      // @ts-expect-error
      expect(result.data.length).toBe(3);
      // @ts-expect-error
      expect(result.data[0].message).toBe("Memory 4");
      // @ts-expect-error
      expect(result.data[2].message).toBe("Memory 2");
    });

    test("returns empty result when no memories exist", async () => {
      const memory = Memory.instance;
      const result = await memory.findRecent("nonexistent", 10);

      expect(result.success).toBe(true);
      // @ts-expect-error
      expect(result.data).toEqual([]);
    });
  });

  describe("find", () => {
    test("returns memories for a chat", async () => {
      const memory = Memory.instance;
      await memory.save({
        chatId: "chat-find",
        author: ERole.User,
        importance: EMemoryImportance.High,
        message: "Test memory",
      });

      const result = await memory.find({ chatId: "chat-find" });

      expect(result).not.toHaveProperty("operation");
      // @ts-expect-error
      expect(result.length).toBe(1);
      // @ts-expect-error
      expect(result[0].message).toBe("Test memory");
    });

    test("returns empty array when no memories match", async () => {
      const memory = Memory.instance;
      const result = await memory.find({ chatId: "nonexistent" });

      expect(result).toEqual([]);
    });

    test("filters by author", async () => {
      const memory = Memory.instance;
      await memory.save({
        chatId: "chat-author",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "User message",
      });
      await memory.save({
        chatId: "chat-author",
        author: ERole.Assistant,
        importance: EMemoryImportance.Low,
        message: "Bot message",
      });

      const result = await memory.find({
        chatId: "chat-author",
        author: ERole.User,
      });

      // @ts-expect-error
      expect(result.length).toBe(1);
      // @ts-expect-error
      expect(result[0].author).toBe(ERole.User);
      // @ts-expect-error
      expect(result[0].message).toBe("User message");
    });

    test("filters by importance levels", async () => {
      const memory = Memory.instance;
      await memory.save({
        chatId: "chat-importance",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "Low importance",
      });
      await memory.save({
        chatId: "chat-importance",
        author: ERole.User,
        importance: EMemoryImportance.Medium,
        message: "Medium importance",
      });
      await memory.save({
        chatId: "chat-importance",
        author: ERole.User,
        importance: EMemoryImportance.High,
        message: "High importance",
      });

      const result = await memory.find({
        chatId: "chat-importance",
        importance: [EMemoryImportance.Low, EMemoryImportance.High],
      });

      // @ts-expect-error
      expect(result.length).toBe(2);
      // @ts-expect-error
      const messages = result.map((m) => m.message);
      expect(messages).toContain("Low importance");
      expect(messages).toContain("High importance");
      expect(messages).not.toContain("Medium importance");
    });

    test("filters by searchString (partial match)", async () => {
      const memory = Memory.instance;
      await memory.save({
        chatId: "chat-search",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "Hello world",
      });
      await memory.save({
        chatId: "chat-search",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "Goodbye world",
      });
      await memory.save({
        chatId: "chat-search",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "Hello there",
      });

      const result = await memory.find({
        chatId: "chat-search",
        searchString: "Hello",
      });

      // @ts-expect-error
      expect(result.length).toBe(2);
      // @ts-expect-error
      const messages = result.map((m) => m.message);
      expect(messages).toContain("Hello world");
      expect(messages).toContain("Hello there");
      expect(messages).not.toContain("Goodbye world");
    });

    test("filters by timeRange", async () => {
      const memory = Memory.instance;
      const now = new Date();
      const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);

      await memory.save({
        chatId: "chat-timerange",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "Recent memory",
      });

      const result = await memory.find({
        chatId: "chat-timerange",
        timeRange: {
          start: threeHoursAgo,
          end: now,
        },
      });

      // @ts-expect-error
      expect(result.length).toBe(1);
      // @ts-expect-error
      expect(result[0].message).toBe("Recent memory");
    });

    test("excludes memories outside timeRange", async () => {
      const memory = Memory.instance;
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

      await memory.save({
        chatId: "chat-timerange-exclude",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "Recent memory",
      });

      const result = await memory.find({
        chatId: "chat-timerange-exclude",
        timeRange: {
          start: twoHoursAgo,
          end: oneHourAgo,
        },
      });

      // @ts-expect-error
      expect(result.length).toBe(0);
    });

    test("applies limit", async () => {
      const memory = Memory.instance;
      for (let i = 0; i < 5; i++) {
        await memory.save({
          chatId: "chat-limit",
          author: ERole.User,
          importance: EMemoryImportance.Low,
          message: `Memory ${i}`,
        });
      }

      const result = await memory.find({
        chatId: "chat-limit",
        limit: 3,
      });

      // @ts-expect-error
      expect(result.length).toBe(3);
    });

    test("combines multiple filters", async () => {
      const memory = Memory.instance;
      await memory.save({
        chatId: "chat-multi",
        author: ERole.User,
        importance: EMemoryImportance.High,
        message: "Matching all filters",
      });
      await memory.save({
        chatId: "chat-multi",
        author: ERole.Assistant,
        importance: EMemoryImportance.High,
        message: "Wrong author",
      });
      await memory.save({
        chatId: "chat-multi",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "Wrong importance",
      });

      const result = await memory.find({
        chatId: "chat-multi",
        author: ERole.User,
        importance: [EMemoryImportance.High],
      });

      // @ts-expect-error
      expect(result.length).toBe(1);
      // @ts-expect-error
      expect(result[0].message).toBe("Matching all filters");
    });

    test("returns memories ordered by createdAt DESC", async () => {
      const memory = Memory.instance;
      await memory.save({
        chatId: "chat-order",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "First memory",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await memory.save({
        chatId: "chat-order",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "Second memory",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await memory.save({
        chatId: "chat-order",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "Third memory",
      });

      const result = await memory.find({ chatId: "chat-order" });

      // @ts-expect-error
      expect(result.length).toBe(3);
      // @ts-expect-error
      expect(result[0].message).toBe("Third memory");
      // @ts-expect-error
      expect(result[2].message).toBe("First memory");
    });
  });
});
