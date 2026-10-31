import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TOption } from "@bellaclaw/shared";
import { EmbeddingClient } from ".";

const originalFetch = globalThis.fetch;
const originalBaseUrl = Bun.env.BELLACLAW_EMBEDDING_BASE_URL;
const originalModel = Bun.env.BELLACLAW_EMBEDDING_MODEL;

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
    Bun.env.BELLACLAW_EMBEDDING_BASE_URL = "http://embedding.test:11434";
    delete Bun.env.BELLACLAW_EMBEDDING_MODEL;
    EmbeddingClientWithInternals._instance = undefined;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    EmbeddingClientWithInternals._instance = originalInstance;

    if (originalBaseUrl === undefined) {
      delete Bun.env.BELLACLAW_EMBEDDING_BASE_URL;
    } else {
      Bun.env.BELLACLAW_EMBEDDING_BASE_URL = originalBaseUrl;
    }

    if (originalModel === undefined) {
      delete Bun.env.BELLACLAW_EMBEDDING_MODEL;
    } else {
      Bun.env.BELLACLAW_EMBEDDING_MODEL = originalModel;
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
        model: "embeddinggemma-2:270m",
        input: ["title: none | text: pierwszy", "title: none | text: second"],
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
        model: "embeddinggemma-2:270m",
        input: [`title: none | text: ${"a".repeat(800)}`, `title: none | text: ${"b".repeat(800)}`],
      }),
      signal: expect.any(AbortSignal),
    });
  });

  test("uses the model from BELLACLAW_EMBEDDING_MODEL", async () => {
    Bun.env.BELLACLAW_EMBEDDING_MODEL = "other-model";
    const fetchMock = mock(async () => embeddingResponse([makeEmbedding(1)]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await EmbeddingClient.instance.embedMany(["hello"]);

    expect(fetchMock).toHaveBeenCalledWith("http://embedding.test:11434/api/embed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "other-model",
        input: ["title: none | text: hello"],
      }),
      signal: expect.any(AbortSignal),
    });
  });

  test("pullModel pulls the configured model", async () => {
    const fetchMock = mock(async () => Response.json({ status: "success" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(EmbeddingClient.instance.pullModel()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("http://embedding.test:11434/api/pull", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "embeddinggemma-2:270m",
        stream: false,
      }),
      signal: expect.any(AbortSignal),
    });
  });

  test("pullModel returns false for non-2xx responses", async () => {
    const fetchMock = mock(async () => Response.json({ error: "not found" }, { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(EmbeddingClient.instance.pullModel()).resolves.toBe(false);
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

  test("embedQuery uses the search query prefix", async () => {
    const embedding = makeEmbedding(0.75);
    const fetchMock = mock(async () => embeddingResponse([embedding]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(EmbeddingClient.instance.embedQuery("gdzie mieszkam")).resolves.toEqual(embedding);
    expect(fetchMock).toHaveBeenCalledWith("http://embedding.test:11434/api/embed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "embeddinggemma-2:270m",
        input: ["task: search result | query: gdzie mieszkam"],
      }),
      signal: expect.any(AbortSignal),
    });
  });

  test("embed returns the first embedding", async () => {
    const embedding = makeEmbedding(0.75);
    const fetchMock = mock(async () => embeddingResponse([embedding]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await EmbeddingClient.instance.embed("hello");

    expect(result).toEqual(embedding);
  });
});
