import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { ERole } from "../ai/types";
import { ConversationStore } from "../conversation";
import { DatabaseConnector } from "../database";

const { Memory } = await import("./index");

async function resetTestDatabase() {
  const db = DatabaseConnector.instance.database;

  await db.run(sql`DROP TRIGGER IF EXISTS fail_live_checkpoint`);
  await db.run(sql`DELETE FROM facts`);
  await db.run(sql`DELETE FROM fact_distillation_state`);
  await db.run(sql`DELETE FROM memories`);
  await db.run(sql`DELETE FROM sqlite_sequence WHERE name IN ('facts', 'memories')`);
}

function resetMemoryInstance() {
  const MemoryWithPrivate = Memory as unknown as {
    _instance: unknown;
  };
  MemoryWithPrivate._instance = undefined;
}

function embedding(x: number, y = 0) {
  const values = new Array<number>(768).fill(0);
  values[0] = x;
  values[1] = y;
  return values;
}

describe("Memory", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    resetMemoryInstance();
  });

  afterEach(() => {
    resetMemoryInstance();
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

  describe("fact persistence", () => {
    test("round-trips vectors and searches live same-chat facts by distance and cutoff", async () => {
      const memory = Memory.instance;
      for (let index = 1; index <= 3; index += 1) {
        await ConversationStore.instance.saveUserMessage(
          DatabaseConnector.instance.database,
          "chat-a",
          ERole.User,
          `Fact source ${index}`,
          new Date(),
        );
      }
      await ConversationStore.instance.saveUserMessage(
        DatabaseConnector.instance.database,
        "chat-b",
        ERole.User,
        "Another chat fact source",
        new Date(),
      );

      const result = await memory.commitLiveFactWindow({
        chatId: "chat-a",
        expectedLastProcessedMessageId: 0,
        lastProcessedMessageId: 3,
        facts: [
          {
            text: "The bicycle is named Comet.",
            embedding: embedding(1),
            sourceMessageId: 1,
            supersedesFactIds: [],
          },
          {
            text: "Ceramics are on Tuesdays.",
            embedding: embedding(0.7, Math.sqrt(1 - 0.7 ** 2)),
            sourceMessageId: 2,
            supersedesFactIds: [],
          },
          {
            text: "An unrelated detail.",
            embedding: embedding(0.68, Math.sqrt(1 - 0.68 ** 2)),
            sourceMessageId: 3,
            supersedesFactIds: [],
          },
        ],
      });

      expect(result.committed).toBe(true);
      if (!result.committed) {
        throw new Error("Expected facts to commit");
      }
      const savedFact = result.facts[0];
      if (savedFact === undefined) {
        throw new Error("Expected one saved fact");
      }
      expect(savedFact.embedding).toHaveLength(768);
      const firstDimension = savedFact.embedding[0];
      if (firstDimension === undefined) {
        throw new Error("Expected a vector dimension");
      }
      expect(firstDimension).toBeCloseTo(1);

      const other = await memory.commitLiveFactWindow({
        chatId: "chat-b",
        expectedLastProcessedMessageId: 0,
        lastProcessedMessageId: 4,
        facts: [
          {
            text: "Another chat has a perfect match.",
            embedding: embedding(1),
            sourceMessageId: 4,
            supersedesFactIds: [],
          },
        ],
      });

      const searchResults = await memory.searchFacts("chat-a", embedding(1), 10);
      expect(searchResults.map((fact) => fact.text)).toEqual([
        "The bicycle is named Comet.",
        "Ceramics are on Tuesdays.",
      ]);
      const closestResult = searchResults[0];
      const secondResult = searchResults[1];
      if (closestResult === undefined || secondResult === undefined) {
        throw new Error("Expected two ordered fact search results");
      }
      expect(closestResult.distance).toBeCloseTo(0);
      expect(secondResult.distance).toBeCloseTo(0.3);

      const candidates = await memory.findLiveFactCandidates("chat-a", embedding(1));
      expect(candidates.map((fact) => fact.text)).toEqual(["The bicycle is named Comet."]);
      expect(await memory.searchFacts("chat-c", embedding(1), 10)).toEqual([]);

      const forgottenIds = searchResults.map((fact) => fact.id);
      await memory.forgetFacts("chat-a", forgottenIds);
      expect(await memory.searchFacts("chat-a", embedding(1), 10)).toEqual([]);
      expect(await memory.findLiveFactCandidates("chat-a", embedding(1))).toEqual([]);

      const survivor = result.facts[2];
      const crossChatFact = other.committed && other.facts[0];
      if (survivor === undefined || !crossChatFact) {
        throw new Error("Expected rejection facts");
      }
      await expect(memory.forgetFacts("chat-a", [survivor.id, crossChatFact.id])).rejects.toThrow(
        "Every fact ID must identify a same-chat live fact",
      );
      expect((await memory.searchFacts("chat-a", survivor.embedding, 10))[0]?.id).toBe(survivor.id);

      await ConversationStore.instance.saveUserMessage(
        DatabaseConnector.instance.database,
        "chat-a",
        ERole.User,
        "The bicycle is named Comet again.",
        new Date(),
      );
      await memory.rememberFact(
        "chat-a",
        "The bicycle is named Comet again.",
        "The bicycle is named Comet again.",
        embedding(1),
        [],
      );
      await memory.rememberFact(
        "chat-a",
        "The bicycle is named Comet again.",
        "The bicycle is named Comet again.",
        embedding(1),
        [],
      );
      expect(
        (await memory.searchFacts("chat-a", embedding(1), 10)).map((fact) => fact.text),
      ).toEqual(["The bicycle is named Comet again."]);
    });

    test("discovers chats and carries both transcript roles through ordered bounded windows", async () => {
      const memory = Memory.instance;
      for (let index = 1; index <= 8; index++) {
        let author = ERole.User;
        if (index % 2 === 0) {
          author = ERole.Assistant;
        }

        await ConversationStore.instance.saveUserMessage(
          DatabaseConnector.instance.database,
          "chat-window",
          author,
          `Window message ${index}`,
          new Date(),
        );
      }
      await ConversationStore.instance.saveUserMessage(
        DatabaseConnector.instance.database,
        "chat-other",
        ERole.User,
        "Other chat message",
        new Date(),
      );

      expect(await ConversationStore.instance.findChatIds()).toEqual(["chat-other", "chat-window"]);

      const firstWindow = await memory.loadLiveFactWindow("chat-window");
      expect(firstWindow.state.lastProcessedMessageId).toBe(0);
      expect(firstWindow.context).toEqual([]);
      expect(firstWindow.messages.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(firstWindow.messages.map((row) => row.author)).toEqual([
        ERole.User,
        ERole.Assistant,
        ERole.User,
        ERole.Assistant,
        ERole.User,
        ERole.Assistant,
      ]);

      const commit = await memory.commitLiveFactWindow({
        chatId: "chat-window",
        expectedLastProcessedMessageId: 0,
        lastProcessedMessageId: 6,
        facts: [],
      });
      expect(commit).toEqual({ committed: true, facts: [] });

      const secondWindow = await memory.loadLiveFactWindow("chat-window");
      expect(secondWindow.state.lastProcessedMessageId).toBe(6);
      expect(secondWindow.context.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(secondWindow.messages.map((row) => row.id)).toEqual([7, 8]);
    });

    test("commits supersessions atomically and rolls back failures", async () => {
      const memory = Memory.instance;
      await ConversationStore.instance.saveUserMessage(
        DatabaseConnector.instance.database,
        "chat-atomic",
        ERole.User,
        "The bicycle used to be called Spark.",
        new Date(),
      );
      const initial = await memory.commitLiveFactWindow({
        chatId: "chat-atomic",
        expectedLastProcessedMessageId: 0,
        lastProcessedMessageId: 1,
        facts: [
          {
            text: "The bicycle used to be called Spark.",
            embedding: embedding(1),
            sourceMessageId: 1,
            supersedesFactIds: [],
          },
        ],
      });
      if (!initial.committed) {
        throw new Error("Expected initial fact to commit");
      }

      const initialFact = initial.facts[0];
      if (initialFact === undefined) {
        throw new Error("Expected initial fact");
      }

      await ConversationStore.instance.saveUserMessage(
        DatabaseConnector.instance.database,
        "chat-atomic",
        ERole.User,
        "The bicycle is now called Comet.",
        new Date(),
      );
      const replacement = await memory.commitLiveFactWindow({
        chatId: "chat-atomic",
        expectedLastProcessedMessageId: 1,
        lastProcessedMessageId: 2,
        facts: [
          {
            text: "The bicycle is now called Comet.",
            embedding: embedding(1),
            sourceMessageId: 2,
            supersedesFactIds: [initialFact.id],
          },
        ],
      });
      expect(replacement.committed).toBe(true);
      expect(
        (await memory.searchFacts("chat-atomic", embedding(1), 10)).map((fact) => fact.text),
      ).toEqual(["The bicycle is now called Comet."]);

      await ConversationStore.instance.saveUserMessage(
        DatabaseConnector.instance.database,
        "chat-atomic",
        ERole.User,
        "This transaction must roll back.",
        new Date(),
      );
      await expect(
        memory.commitLiveFactWindow({
          chatId: "chat-atomic",
          expectedLastProcessedMessageId: 2,
          lastProcessedMessageId: 3,
          facts: [
            {
              text: "This transaction must roll back.",
              embedding: embedding(0, 1),
              sourceMessageId: 3,
              supersedesFactIds: [999],
            },
          ],
        }),
      ).rejects.toThrow("Failed to supersede every prepared same-chat live fact");

      expect((await memory.loadLiveFactWindow("chat-atomic")).state.lastProcessedMessageId).toBe(2);
      expect(await memory.searchFacts("chat-atomic", embedding(0, 1), 10)).toEqual([]);
    });

    test("rejects a stale live checkpoint without writing facts", async () => {
      const memory = Memory.instance;
      for (let index = 1; index <= 5; index += 1) {
        await ConversationStore.instance.saveUserMessage(
          DatabaseConnector.instance.database,
          "chat-stale",
          ERole.User,
          `Stale source ${index}`,
          new Date(),
        );
      }
      await memory.commitLiveFactWindow({
        chatId: "chat-stale",
        expectedLastProcessedMessageId: 0,
        lastProcessedMessageId: 4,
        facts: [],
      });

      const result = await memory.commitLiveFactWindow({
        chatId: "chat-stale",
        expectedLastProcessedMessageId: 0,
        lastProcessedMessageId: 5,
        facts: [
          {
            text: "A stale fact.",
            embedding: embedding(1),
            sourceMessageId: 5,
            supersedesFactIds: [],
          },
        ],
      });

      expect(result).toEqual({ committed: false, reason: "stale-checkpoint" });
      expect((await memory.loadLiveFactWindow("chat-stale")).state.lastProcessedMessageId).toBe(4);
      expect(await memory.searchFacts("chat-stale", embedding(1), 10)).toEqual([]);
    });

    test("rejects a commit that would not advance the checkpoint", async () => {
      const memory = Memory.instance;

      await expect(
        memory.commitLiveFactWindow({
          chatId: "chat-no-advance",
          expectedLastProcessedMessageId: 4,
          lastProcessedMessageId: 4,
          facts: [],
        }),
      ).rejects.toThrow("A committed fact window must advance the checkpoint");
    });

    test("rejects fact provenance outside the current same-chat user window", async () => {
      const memory = Memory.instance;
      await ConversationStore.instance.saveUserMessage(
        DatabaseConnector.instance.database,
        "chat-provenance",
        ERole.Assistant,
        "Assistant context only",
        new Date(),
      );

      await expect(
        memory.commitLiveFactWindow({
          chatId: "chat-provenance",
          expectedLastProcessedMessageId: 0,
          lastProcessedMessageId: 1,
          facts: [
            {
              text: "Invalid assistant-authored fact.",
              embedding: embedding(1),
              sourceMessageId: 1,
              supersedesFactIds: [],
            },
          ],
        }),
      ).rejects.toThrow("Every fact source must be a current-window user transcript row");
      expect(
        (await memory.loadLiveFactWindow("chat-provenance")).state.lastProcessedMessageId,
      ).toBe(0);
    });
  });
});
