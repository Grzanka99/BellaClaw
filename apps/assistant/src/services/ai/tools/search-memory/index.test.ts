import { afterEach, describe, expect, mock, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { EmbeddingClient } from "../../../embedding";
import type { TEventRequester } from "../../../events";
import { EEventType } from "../../../events/catalog";
import { testEventRequester } from "../../../events/test-utils";
import { MEMORY_REQUEST_TIMEOUT_MS, Memory } from "../../../memory";
import { DefaultConfigRecord } from "../../../settings/schema";
import { SSearchMemoryArgs, searchMemory } from ".";

type TSingletonStatic = {
  _instance: unknown;
};

const EmbeddingClientWithInternals = EmbeddingClient as unknown as TSingletonStatic;
const MemoryWithInternals = Memory as unknown as TSingletonStatic;
const originalEmbeddingClient = EmbeddingClientWithInternals._instance;
const originalMemory = MemoryWithInternals._instance;
// answers memory.facts.refresh.requested at once
const request = mock(async () => ({ payload: {} }));
const context = {
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  events: { ...testEventRequester, request: request as unknown as TEventRequester["request"] },
  verifySettings: mock(async () => undefined),
  runScheduledTask: mock(async () => {
    throw new Error("not used");
  }),
};
afterEach(() => {
  request.mockClear();
  EmbeddingClientWithInternals._instance = originalEmbeddingClient;
  MemoryWithInternals._instance = originalMemory;
});

function execute(chatId: string, args: unknown) {
  return searchMemory.createAgentTool({ ...context, chatId }).execute("call", args);
}

describe("search-memory", () => {
  test("uses the semantic memory search schema", () => {
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "facts" })).toBe(true);
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "" })).toBe(false);
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "   " })).toBe(false);
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "a".repeat(120) })).toBe(true);
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "a".repeat(121) })).toBe(false);
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "facts", limit: 0 })).toBe(false);
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "facts", limit: 25 })).toBe(true);
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "facts", limit: 26 })).toBe(
      false,
    );
  });

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
    const embedQuery = mock(async () => vector);
    const searchFacts = mock(async () => facts);
    EmbeddingClientWithInternals._instance = { embedQuery };
    MemoryWithInternals._instance = { searchFacts };

    const result = await execute("chat-1", { query: "What does the user drink?" });

    expect(request).toHaveBeenCalledWith(
      EEventType.MemoryFactsRefreshRequested,
      {},
      expect.objectContaining({
        outcome: EEventType.MemoryFactsRefreshed,
        key: "chat-1",
        timeoutMs: MEMORY_REQUEST_TIMEOUT_MS,
      }),
    );
    expect(embedQuery).toHaveBeenCalledWith("What does the user drink?");
    expect(searchFacts).toHaveBeenCalledWith("chat-1", vector, 10);
    expect(result.details).toEqual({ facts });
  });

  test("uses a custom result limit", async () => {
    const vector = [0.3];
    const embedQuery = mock(async () => vector);
    const searchFacts = mock(async () => []);
    EmbeddingClientWithInternals._instance = { embedQuery };
    MemoryWithInternals._instance = { searchFacts };

    await execute("chat-2", { query: "travel plans", limit: 4 });

    expect(searchFacts).toHaveBeenCalledWith("chat-2", vector, 4);
  });

  test("throws when the embedding service is unavailable", async () => {
    const embedQuery = mock(async () => undefined);
    const searchFacts = mock(async () => []);
    EmbeddingClientWithInternals._instance = { embedQuery };
    MemoryWithInternals._instance = { searchFacts };

    await expect(execute("chat-3", { query: "preferences" })).rejects.toThrow(
      "Embedding service unavailable",
    );
    expect(searchFacts).not.toHaveBeenCalled();
  });

  test("translates memory errors", async () => {
    const embedQuery = mock(async () => [0.4]);
    const searchFacts = mock(async () => {
      throw new Error("database unavailable");
    });
    EmbeddingClientWithInternals._instance = { embedQuery };
    MemoryWithInternals._instance = { searchFacts };

    await expect(execute("chat-4", { query: "important facts" })).rejects.toThrow(
      "Memory search failed: Error: database unavailable",
    );
  });

  test("requires a chat owner before searching memory", async () => {
    const embedQuery = mock(async () => [0.1]);
    EmbeddingClientWithInternals._instance = { embedQuery };
    const tool = searchMemory.createAgentTool({ ...context, chatId: undefined });

    await expect(tool.execute("call", { query: "preferences" })).rejects.toThrow(
      "This tool requires a chat owner",
    );
    expect(request).not.toHaveBeenCalled();
    expect(embedQuery).not.toHaveBeenCalled();
  });
});
