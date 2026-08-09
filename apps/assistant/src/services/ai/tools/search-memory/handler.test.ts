import { afterEach, describe, expect, mock, test } from "bun:test";
import { EmbeddingClient } from "../../../embedding";
import { Memory } from "../../../memory";
import { handleSearchMemory } from "./handler";

type TSingletonStatic = {
  _instance: unknown;
};

const EmbeddingClientWithInternals = EmbeddingClient as unknown as TSingletonStatic;
const MemoryWithInternals = Memory as unknown as TSingletonStatic;
const originalEmbeddingClient = EmbeddingClientWithInternals._instance;
const originalMemory = MemoryWithInternals._instance;

afterEach(() => {
  EmbeddingClientWithInternals._instance = originalEmbeddingClient;
  MemoryWithInternals._instance = originalMemory;
});

describe("handleSearchMemory", () => {
  test("forwards the query, uses the default limit, and returns facts", async () => {
    const vector = [0.1, 0.2];
    const facts = [
      {
        id: 1,
        text: "The user likes tea",
        createdAt: new Date("2026-08-01T10:00:00.000Z"),
        sourceMessageId: 2,
        distance: 0.1,
      },
    ];
    const embed = mock(async () => vector);
    const searchFacts = mock(async () => facts);
    EmbeddingClientWithInternals._instance = { embed };
    MemoryWithInternals._instance = { searchFacts };

    const result = await handleSearchMemory("chat-1", { query: "What does the user drink?" });

    expect(embed).toHaveBeenCalledWith("What does the user drink?");
    expect(searchFacts).toHaveBeenCalledWith("chat-1", vector, 10);
    expect(result).toEqual({ facts });
  });

  test("uses a custom result limit", async () => {
    const vector = [0.3];
    const embed = mock(async () => vector);
    const searchFacts = mock(async () => []);
    EmbeddingClientWithInternals._instance = { embed };
    MemoryWithInternals._instance = { searchFacts };

    await handleSearchMemory("chat-2", { query: "travel plans", limit: 4 });

    expect(searchFacts).toHaveBeenCalledWith("chat-2", vector, 4);
  });

  test("throws when the embedding service is unavailable", async () => {
    const embed = mock(async () => undefined);
    const searchFacts = mock(async () => []);
    EmbeddingClientWithInternals._instance = { embed };
    MemoryWithInternals._instance = { searchFacts };

    await expect(handleSearchMemory("chat-3", { query: "preferences" })).rejects.toThrow(
      "Embedding service unavailable",
    );
    expect(searchFacts).not.toHaveBeenCalled();
  });

  test("translates memory errors", async () => {
    const embed = mock(async () => [0.4]);
    const searchFacts = mock(async () => {
      throw new Error("database unavailable");
    });
    EmbeddingClientWithInternals._instance = { embed };
    MemoryWithInternals._instance = { searchFacts };

    await expect(handleSearchMemory("chat-4", { query: "important facts" })).rejects.toThrow(
      "Memory search failed: Error: database unavailable",
    );
  });
});
