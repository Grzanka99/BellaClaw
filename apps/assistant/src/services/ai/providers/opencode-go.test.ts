import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import {
  createModels,
  getSupportedThinkingLevels,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { opencodeGoProvider as bundledOpencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { opencodeGoProvider } from "./opencode-go";

const metadata = {
  name: "Current model",
  tool_call: true,
  reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "high", "max", "default", null] }],
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 1000000, output: 64000 },
  cost: {
    input: 1,
    output: 5,
    cache_read: 0.1,
    cache_write: 1.25,
    tiers: [{ input: 2, output: 10, tier: { type: "context", size: 200000 } }],
  },
};
const originalApiKey = Bun.env.OPENCODE_API_KEY;
let fetchMock: Mock<(input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>>;

beforeEach(() => {
  fetchMock = spyOn(globalThis, "fetch");
  Bun.env.OPENCODE_API_KEY = "catalog-test-key";
});

afterEach(() => {
  fetchMock.mockRestore();
  Bun.env.OPENCODE_API_KEY = originalApiKey;
});

function serveCatalog(ids: string[], models: Record<string, unknown>) {
  fetchMock.mockImplementation(async (input) => {
    if (String(input).endsWith("/models")) {
      return Response.json({ data: ids.map((id) => ({ id })) });
    }
    return Response.json({ "opencode-go": { models } });
  });
}

function collection(modelsStore = new InMemoryModelsStore()) {
  const models = createModels({ modelsStore });
  models.setProvider(opencodeGoProvider([]));
  return models;
}

describe("OpenCode Go discovery", () => {
  test("builds live chat models from metadata and preserves bundled protocol settings", async () => {
    serveCatalog(
      [
        "qwen3.8-flash",
        "anthropic-current",
        "responses-current",
        "completions-current",
        "google-current",
        "unknown",
      ],
      {
        "anthropic-current": {
          ...metadata,
          temperature: false,
          provider: { npm: "@ai-sdk/anthropic" },
        },
        "responses-current": { ...metadata, provider: { npm: "@ai-sdk/openai" } },
        "completions-current": { ...metadata, interleaved: { field: "reasoning_content" } },
        "google-current": { ...metadata, provider: { npm: "@ai-sdk/google" } },
      },
    );
    const models = collection();
    expect((await models.refresh()).errors.size).toBe(0);
    expect(models.getModels().map((model) => model.id)).toEqual([
      "qwen3.8-flash",
      "anthropic-current",
      "responses-current",
      "completions-current",
    ]);
    const bundledQwen = bundledOpencodeGoProvider()
      .getModels()
      .find((model) => model.id === "qwen3.8-flash");
    expect(models.getModel("opencode-go", "qwen3.8-flash")).toMatchObject({
      ...bundledQwen,
      compat: { ...bundledQwen?.compat, supportsMidConvoEffort: true },
    });
    expect(models.getModel("opencode-go", "anthropic-current")).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/inference/go",
      compat: {
        forceAdaptiveThinking: true,
        supportsMidConvoEffort: true,
        supportsTemperature: false,
      },
    });
    expect(models.getModel("opencode-go", "responses-current")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://opencode.ai/inference/go/v1",
      compat: { sessionAffinityFormat: "openai-nosession" },
    });
    const model = models.getModel("opencode-go", "completions-current");
    if (model === undefined) {
      throw new Error("Live model missing");
    }
    expect(model).toMatchObject({
      api: "openai-completions",
      input: ["text", "image"],
      contextWindow: 1000000,
      maxTokens: 64000,
      compat: { maxTokensField: "max_tokens", requiresReasoningContentOnAssistantMessages: true },
      cost: {
        input: 1,
        output: 5,
        cacheRead: 0.1,
        cacheWrite: 1.25,
        tiers: [{ inputTokensAbove: 200000, input: 2, output: 10 }],
      },
    });
    expect(getSupportedThinkingLevels(model)).toEqual(["low", "high", "max"]);
    expect(models.getAllModels()).toEqual(models.getModels());
  });

  test("uses the hourly cache and forced refresh publishes the current live catalog", async () => {
    serveCatalog(["completions-current"], { "completions-current": metadata });
    const models = collection();
    await models.refresh();
    await models.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    serveCatalog(["responses-current"], {
      "responses-current": { ...metadata, provider: { npm: "@ai-sdk/openai" } },
    });
    await models.refresh({ force: true });
    expect(models.getModels().map((model) => model.id)).toEqual(["responses-current"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const now = spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60 * 1000 + 1);
    try {
      await models.refresh();
      expect(fetchMock).toHaveBeenCalledTimes(6);
    } finally {
      now.mockRestore();
    }
  });

  test.each([
    ["HTTP failure", () => new Response("unavailable", { status: 503 })],
    ["malformed JSON", () => new Response("not JSON")],
    ["invalid schema", () => Response.json({ data: [{ id: 42 }] })],
    ["empty list", () => Response.json({ data: [] })],
  ])("keeps the last successful catalog after %s", async (_name, response) => {
    serveCatalog(["completions-current"], { "completions-current": metadata });
    const models = collection();
    await models.refresh();
    fetchMock.mockImplementation(async () => response());
    expect((await models.refresh({ force: true })).errors.has("opencode-go")).toBe(true);
    expect(models.getModels().map((model) => model.id)).toEqual(["completions-current"]);
  });

  test("waits out a cooldown after a failed refresh unless the refresh is forced", async () => {
    fetchMock.mockRejectedValue(new Error("Offline"));
    const models = collection();
    await models.refresh();
    await models.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await models.refresh({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const now = spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60 * 1000 + 1);
    try {
      await models.refresh();
      expect(fetchMock).toHaveBeenCalledTimes(6);
    } finally {
      now.mockRestore();
    }
  });

  test("keeps required bundled models that the live list omits", async () => {
    serveCatalog(["completions-current"], { "completions-current": metadata });
    const models = createModels();
    models.setProvider(opencodeGoProvider(["grok-4.7"]));
    await models.refresh();
    expect(models.getModels().map((model) => model.id)).toEqual([
      "completions-current",
      "grok-4.7",
    ]);
    serveCatalog([], {});
    expect((await models.refresh({ force: true })).errors.has("opencode-go")).toBe(true);
    expect(models.getModels().map((model) => model.id)).toEqual([
      "completions-current",
      "grok-4.7",
    ]);
  });

  test("adds required bundled models to a restored catalog that lacks them", async () => {
    serveCatalog(["completions-current"], { "completions-current": metadata });
    const store = new InMemoryModelsStore();
    await collection(store).refresh();
    const restored = createModels({ modelsStore: store });
    restored.setProvider(opencodeGoProvider(["grok-4.7"]));
    await restored.refresh({ allowNetwork: false });
    expect(restored.getModels().map((model) => model.id)).toEqual([
      "completions-current",
      "grok-4.7",
    ]);
  });

  test("keeps the bundled catalog when its first fetch fails", async () => {
    fetchMock.mockRejectedValue(new Error("Offline"));
    const models = collection();
    expect((await models.refresh()).errors.has("opencode-go")).toBe(true);
    expect(models.getModels().map((model) => model.id)).toEqual(
      bundledOpencodeGoProvider()
        .getModels()
        .map((model) => model.id),
    );
  });

  test("restores the stored catalog without network access", async () => {
    serveCatalog(["completions-current"], { "completions-current": metadata });
    const store = new InMemoryModelsStore();
    await collection(store).refresh();
    const restored = collection(store);
    await restored.refresh({ allowNetwork: false });
    expect(restored.getModels().map((model) => model.id)).toEqual(["completions-current"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("streams a discovered model through native Go transport with conversation routing", async () => {
    serveCatalog(["completions-current"], { "completions-current": metadata });
    const models = collection();
    await models.refresh();
    const model = models.getModel("opencode-go", "completions-current");
    if (model === undefined) {
      throw new Error("Live model missing");
    }
    let request: Request | undefined;
    fetchMock.mockImplementation(async (input, init) => {
      if (input instanceof Request) {
        request = new Request(input, init);
      } else {
        request = new Request(String(input), init);
      }
      return new Response(
        'data: {"id":"reply","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\ndata: {"id":"reply","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const reply = await models.completeSimple(
      model,
      { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] },
      { sessionId: "conversation-session" },
    );
    expect(reply.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(reply.stopReason).toBe("stop");
    expect(request?.url).toBe("https://opencode.ai/inference/go/v1/chat/completions");
    expect(request?.headers.get("x-opencode-session")).toBe("conversation-session");
    expect(request?.headers.get("authorization")).toBe("Bearer catalog-test-key");
  });
});
