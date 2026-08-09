import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TOption } from "@bellaclaw/shared";
import { EmbeddingClient } from ".";

const originalFetch = globalThis.fetch;
const originalBaseUrl = Bun.env.OLLAMA_BASE_URL;

type TEmbeddingClientStatic = {
  _instance: TOption<EmbeddingClient>;
};

const EmbeddingClientWithInternals = EmbeddingClient as unknown as TEmbeddingClientStatic;
const originalInstance = EmbeddingClientWithInternals._instance;

function makeEmbedding(value: number): number[] {
  return Array.from({ length: 768 }, () => value);
}

function embeddingResponse(embeddings: number[][]): Response {
  return Response.json({ embeddings });
}

describe("EmbeddingClient", () => {
  beforeEach(() => {
    Bun.env.OLLAMA_BASE_URL = "http://embedding.test:11434";
    EmbeddingClientWithInternals._instance = undefined;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    EmbeddingClientWithInternals._instance = originalInstance;

    if (originalBaseUrl === undefined) {
      delete Bun.env.OLLAMA_BASE_URL;
    } else {
      Bun.env.OLLAMA_BASE_URL = originalBaseUrl;
    }
  });

  test("returns 768-dimensional embeddings", async () => {
    const first = makeEmbedding(0.25);
    const second = makeEmbedding(0.5);
    const fetchMock = mock(async () => embeddingResponse([first, second]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = EmbeddingClient.instance;
    const result = await client.embedMany(["pierwszy", "second"]);

    expect(EmbeddingClient.instance).toBe(client);
    expect(result).toEqual([first, second]);
    expect(fetchMock).toHaveBeenCalledWith("http://embedding.test:11434/api/embed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "paraphrase-multilingual",
        input: ["pierwszy", "second"],
      }),
      signal: expect.any(AbortSignal),
    });
  });

  test("caps every batched input at 800 characters", async () => {
    const fetchMock = mock(async () => embeddingResponse([makeEmbedding(1), makeEmbedding(2)]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await EmbeddingClient.instance.embedMany(["a".repeat(801), "b".repeat(900)]);

    expect(fetchMock).toHaveBeenCalledWith("http://embedding.test:11434/api/embed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "paraphrase-multilingual",
        input: ["a".repeat(800), "b".repeat(800)],
      }),
      signal: expect.any(AbortSignal),
    });
  });

  test("returns undefined for non-2xx responses", async () => {
    const fetchMock = mock(async () => new Response("failed", { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(EmbeddingClient.instance.embedMany(["hello"])).resolves.toBeUndefined();
  });

  test("returns undefined when the request throws", async () => {
    const fetchMock = mock(async () => {
      throw new Error("network down");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(EmbeddingClient.instance.embedMany(["hello"])).resolves.toBeUndefined();
  });

  test("returns undefined for invalid JSON", async () => {
    const fetchMock = mock(async () => new Response("not-json"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(EmbeddingClient.instance.embedMany(["hello"])).resolves.toBeUndefined();
  });

  test("returns undefined for malformed response shape", async () => {
    const fetchMock = mock(async () => Response.json({ embeddings: "invalid" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(EmbeddingClient.instance.embedMany(["hello"])).resolves.toBeUndefined();
  });

  test("returns undefined for embeddings with the wrong dimension", async () => {
    const fetchMock = mock(async () => embeddingResponse([makeEmbedding(1).slice(0, 767)]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(EmbeddingClient.instance.embedMany(["hello"])).resolves.toBeUndefined();
  });

  test("embed returns the first embedding", async () => {
    const embedding = makeEmbedding(0.75);
    const fetchMock = mock(async () => embeddingResponse([embedding]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await EmbeddingClient.instance.embed("hello");

    expect(result).toEqual(embedding);
  });
});
