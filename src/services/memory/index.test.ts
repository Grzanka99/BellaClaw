import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { Memory, PERSISTENT_MEMORY_DB } from "./index";
import { EMemoryAuthor } from "./types";

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
        importance: 1,
        message: "Test memory",
      });

      expect(result).not.toHaveProperty("operation");
      expect(result).toEqual({
        userId: "user-123",
        author: EMemoryAuthor.User,
        guild: "guild-456",
        importance: 1,
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
        importance: 2,
        message: "Memory without guild",
      });

      expect(result).not.toHaveProperty("operation");
      expect(result).toEqual({
        userId: "user-789",
        author: EMemoryAuthor.Bot,
        guild: null,
        importance: 2,
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
        importance: 0,
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
        importance: 1,
        message: "Memory to remove",
      });

      const result = await memory.remove("1");

      expect(result).not.toHaveProperty("operation");
      expect(result).toEqual({
        id: 1,
        userId: "user-remove",
        author: EMemoryAuthor.User,
        guild: "guild-remove",
        importance: 1,
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
        importance: 1,
        message: "First memory",
      });
      await memory.save({
        userId: "user-read",
        author: EMemoryAuthor.Bot,
        guild: "guild-1",
        importance: 2,
        message: "Second memory",
      });
      await memory.save({
        userId: "user-read",
        author: EMemoryAuthor.User,
        guild: "guild-1",
        importance: 0,
        message: "Third memory",
      });
      await memory.save({
        userId: "user-read",
        author: EMemoryAuthor.Bot,
        guild: null,
        importance: 1,
        message: "Fourth memory",
      });
      await memory.save({
        userId: "user-read",
        author: EMemoryAuthor.User,
        guild: "guild-2",
        importance: 2,
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
        importance: 1,
        message: "User A memory",
      });
      await memory.save({
        userId: "user-b",
        author: EMemoryAuthor.User,
        guild: null,
        importance: 1,
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
});
