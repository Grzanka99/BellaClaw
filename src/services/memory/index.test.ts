import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { Memory, PERSISTENT_MEMORY_DB } from "./index";
import { EMemoryAuthor, EMemoryImportance } from "./types";

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
        userId: "user-123",
        author: EMemoryAuthor.User,
        guild: "guild-456",
        importance: EMemoryImportance.Medium,
        message: "Test memory",
      });

      expect(result).not.toHaveProperty("operation");
      expect(result).toEqual({
        userId: "user-123",
        author: EMemoryAuthor.User,
        guild: "guild-456",
        importance: EMemoryImportance.Medium,
        message: "Test memory",
        createdAt: expect.any(Date),
        lastReadAt: expect.any(Date),
      });
    });

    test("saves a memory without guild (null)", async () => {
      const memory = Memory.instance;
      const result = await memory.save({
        userId: "user-789",
        author: EMemoryAuthor.Bot,
        guild: null,
        importance: EMemoryImportance.High,
        message: "Memory without guild",
      });

      expect(result).not.toHaveProperty("operation");
      expect(result).toEqual({
        userId: "user-789",
        author: EMemoryAuthor.Bot,
        guild: null,
        importance: EMemoryImportance.High,
        message: "Memory without guild",
        createdAt: expect.any(Date),
        lastReadAt: expect.any(Date),
      });
    });

    test("sets createdAt and lastReadAt to the same timestamp", async () => {
      const memory = Memory.instance;
      const result = await memory.save({
        userId: "user-timestamp",
        author: EMemoryAuthor.User,
        guild: null,
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
        userId: "user-remove",
        author: EMemoryAuthor.User,
        guild: "guild-remove",
        importance: EMemoryImportance.Medium,
        message: "Memory to remove",
      });

      const result = await memory.remove("1");

      expect(result).not.toHaveProperty("operation");
      expect(result).toEqual({
        id: 1,
        userId: "user-remove",
        author: EMemoryAuthor.User,
        guild: "guild-remove",
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
    test("returns all memories for a user", async () => {
      const memory = Memory.instance;

      await memory.save({
        userId: "user-read",
        author: EMemoryAuthor.User,
        guild: "guild-1",
        importance: EMemoryImportance.Medium,
        message: "First memory",
      });
      await memory.save({
        userId: "user-read",
        author: EMemoryAuthor.Bot,
        guild: "guild-1",
        importance: EMemoryImportance.High,
        message: "Second memory",
      });
      await memory.save({
        userId: "user-read",
        author: EMemoryAuthor.User,
        guild: "guild-1",
        importance: EMemoryImportance.Low,
        message: "Third memory",
      });
      await memory.save({
        userId: "user-read",
        author: EMemoryAuthor.Bot,
        guild: null,
        importance: EMemoryImportance.Medium,
        message: "Fourth memory",
      });
      await memory.save({
        userId: "user-read",
        author: EMemoryAuthor.User,
        guild: "guild-2",
        importance: EMemoryImportance.High,
        message: "Fifth memory",
      });

      const result = await memory.readFullMemory("user-read");

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

    test("returns empty array when no memories exist for user", async () => {
      const memory = Memory.instance;
      const result = await memory.readFullMemory("nonexistent-user");

      expect(result).toEqual([]);
    });

    test("returns only memories for the specified user", async () => {
      const memory = Memory.instance;

      await memory.save({
        userId: "user-a",
        author: EMemoryAuthor.User,
        guild: null,
        importance: EMemoryImportance.Medium,
        message: "User A memory",
      });
      await memory.save({
        userId: "user-b",
        author: EMemoryAuthor.User,
        guild: null,
        importance: EMemoryImportance.Medium,
        message: "User B memory",
      });

      const result = await memory.readFullMemory("user-a");

      expect(result).toBeDefined();
      // @ts-expect-error
      expect(result?.length).toBe(1);
      // @ts-expect-error
      expect(result[0].message).toBe("User A memory");
      // @ts-expect-error
      expect(result[0].userId).toBe("user-a");
    });
  });

  describe("find", () => {
    test("returns memories for a user", async () => {
      const memory = Memory.instance;
      await memory.save({
        userId: "user-find",
        author: EMemoryAuthor.User,
        guild: "guild-1",
        importance: EMemoryImportance.High,
        message: "Test memory",
      });

      const result = await memory.find({ userId: "user-find" });

      expect(result).not.toHaveProperty("operation");
      // @ts-expect-error
      expect(result.length).toBe(1);
      // @ts-expect-error
      expect(result[0].message).toBe("Test memory");
    });

    test("returns empty array when no memories match", async () => {
      const memory = Memory.instance;
      const result = await memory.find({ userId: "nonexistent" });

      expect(result).toEqual([]);
    });

    test("filters by author", async () => {
      const memory = Memory.instance;
      await memory.save({
        userId: "user-author",
        author: EMemoryAuthor.User,
        guild: null,
        importance: EMemoryImportance.Low,
        message: "User message",
      });
      await memory.save({
        userId: "user-author",
        author: EMemoryAuthor.Bot,
        guild: null,
        importance: EMemoryImportance.Low,
        message: "Bot message",
      });

      const result = await memory.find({
        userId: "user-author",
        author: EMemoryAuthor.User,
      });

      // @ts-expect-error
      expect(result.length).toBe(1);
      // @ts-expect-error
      expect(result[0].author).toBe(EMemoryAuthor.User);
      // @ts-expect-error
      expect(result[0].message).toBe("User message");
    });

    test("filters by guild", async () => {
      const memory = Memory.instance;
      await memory.save({
        userId: "user-guild",
        author: EMemoryAuthor.User,
        guild: "guild-alpha",
        importance: EMemoryImportance.Low,
        message: "Alpha memory",
      });
      await memory.save({
        userId: "user-guild",
        author: EMemoryAuthor.User,
        guild: "guild-beta",
        importance: EMemoryImportance.Low,
        message: "Beta memory",
      });

      const result = await memory.find({
        userId: "user-guild",
        guild: "guild-alpha",
      });

      // @ts-expect-error
      expect(result.length).toBe(1);
      // @ts-expect-error
      expect(result[0].guild).toBe("guild-alpha");
      // @ts-expect-error
      expect(result[0].message).toBe("Alpha memory");
    });

    test("filters by importance levels", async () => {
      const memory = Memory.instance;
      await memory.save({
        userId: "user-importance",
        author: EMemoryAuthor.User,
        guild: null,
        importance: EMemoryImportance.Low,
        message: "Low importance",
      });
      await memory.save({
        userId: "user-importance",
        author: EMemoryAuthor.User,
        guild: null,
        importance: EMemoryImportance.Medium,
        message: "Medium importance",
      });
      await memory.save({
        userId: "user-importance",
        author: EMemoryAuthor.User,
        guild: null,
        importance: EMemoryImportance.High,
        message: "High importance",
      });

      const result = await memory.find({
        userId: "user-importance",
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
        userId: "user-search",
        author: EMemoryAuthor.User,
        guild: null,
        importance: EMemoryImportance.Low,
        message: "Hello world",
      });
      await memory.save({
        userId: "user-search",
        author: EMemoryAuthor.User,
        guild: null,
        importance: EMemoryImportance.Low,
        message: "Goodbye world",
      });
      await memory.save({
        userId: "user-search",
        author: EMemoryAuthor.User,
        guild: null,
        importance: EMemoryImportance.Low,
        message: "Hello there",
      });

      const result = await memory.find({
        userId: "user-search",
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
        userId: "user-timerange",
        author: EMemoryAuthor.User,
        guild: null,
        importance: EMemoryImportance.Low,
        message: "Recent memory",
      });

      const result = await memory.find({
        userId: "user-timerange",
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
        userId: "user-timerange-exclude",
        author: EMemoryAuthor.User,
        guild: null,
        importance: EMemoryImportance.Low,
        message: "Recent memory",
      });

      const result = await memory.find({
        userId: "user-timerange-exclude",
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
          userId: "user-limit",
          author: EMemoryAuthor.User,
          guild: null,
          importance: EMemoryImportance.Low,
          message: `Memory ${i}`,
        });
      }

      const result = await memory.find({
        userId: "user-limit",
        limit: 3,
      });

      // @ts-expect-error
      expect(result.length).toBe(3);
    });

    test("combines multiple filters", async () => {
      const memory = Memory.instance;
      await memory.save({
        userId: "user-multi",
        author: EMemoryAuthor.User,
        guild: "guild-multi",
        importance: EMemoryImportance.High,
        message: "Matching all filters",
      });
      await memory.save({
        userId: "user-multi",
        author: EMemoryAuthor.Bot,
        guild: "guild-multi",
        importance: EMemoryImportance.High,
        message: "Wrong author",
      });
      await memory.save({
        userId: "user-multi",
        author: EMemoryAuthor.User,
        guild: "guild-other",
        importance: EMemoryImportance.High,
        message: "Wrong guild",
      });
      await memory.save({
        userId: "user-multi",
        author: EMemoryAuthor.User,
        guild: "guild-multi",
        importance: EMemoryImportance.Low,
        message: "Wrong importance",
      });

      const result = await memory.find({
        userId: "user-multi",
        author: EMemoryAuthor.User,
        guild: "guild-multi",
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
        userId: "user-order",
        author: EMemoryAuthor.User,
        guild: null,
        importance: EMemoryImportance.Low,
        message: "First memory",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await memory.save({
        userId: "user-order",
        author: EMemoryAuthor.User,
        guild: null,
        importance: EMemoryImportance.Low,
        message: "Second memory",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await memory.save({
        userId: "user-order",
        author: EMemoryAuthor.User,
        guild: null,
        importance: EMemoryImportance.Low,
        message: "Third memory",
      });

      const result = await memory.find({ userId: "user-order" });

      // @ts-expect-error
      expect(result.length).toBe(3);
      // @ts-expect-error
      expect(result[0].message).toBe("Third memory");
      // @ts-expect-error
      expect(result[2].message).toBe("First memory");
    });
  });
});
