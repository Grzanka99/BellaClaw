import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { searchWeb } from "../../../../lib/web";

const originalFetch = globalThis.fetch;
const originalTavilyApiKey = Bun.env.TAVILY_API_KEY;

type TMockFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

function useMockFetch(handler: TMockFetch) {
  globalThis.fetch = handler as unknown as typeof fetch;
}

function restoreTavilyApiKey() {
  if (originalTavilyApiKey === undefined) {
    delete Bun.env.TAVILY_API_KEY;
    return;
  }

  Bun.env.TAVILY_API_KEY = originalTavilyApiKey;
}

function readInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

describe("searchWeb", () => {
  beforeEach(() => {
    Bun.env.TAVILY_API_KEY = "test-key";
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    restoreTavilyApiKey();
    globalThis.fetch = originalFetch;
  });

  test("posts a Tavily request and returns Tavily result fields", async () => {
    let requestedUrl = "";
    let requestedBody: unknown;

    useMockFetch(async (input, init) => {
      requestedUrl = readInputUrl(input);

      if (typeof init?.body === "string") {
        requestedBody = JSON.parse(init.body);
      }

      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Example Docs",
              url: "https://example.com/docs",
              content: "Official docs content summary.",
              score: 0.91,
              raw_content: "ignored",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const results = await searchWeb({
      query: "example docs",
      maxResults: 3,
      topic: "news",
      timeRange: "week",
    });

    expect(requestedUrl).toBe("https://api.tavily.com/search");
    expect(requestedBody).toEqual({
      query: "example docs",
      search_depth: "basic",
      max_results: 3,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      topic: "news",
      time_range: "week",
    });
    expect(results).toEqual([
      {
        title: "Example Docs",
        url: "https://example.com/docs",
        content: "Official docs content summary.",
        score: 0.91,
      },
    ]);
  });

  test("fails clearly when TAVILY_API_KEY is missing", async () => {
    let called = false;
    delete Bun.env.TAVILY_API_KEY;
    useMockFetch(async () => {
      called = true;
      return new Response("should not fetch");
    });

    await expect(searchWeb({ query: "example" })).rejects.toThrow(
      "TAVILY_API_KEY is required for web search",
    );
    expect(called).toBe(false);
  });

  test("fails clearly on non-2xx Tavily responses", async () => {
    useMockFetch(async () => new Response("temporary outage", { status: 500 }));

    await expect(searchWeb({ query: "example" })).rejects.toThrow(
      "Tavily search failed with status 500: temporary outage",
    );
  });

  test("fails clearly on Tavily quota exhaustion", async () => {
    useMockFetch(async () => new Response("monthly limit reached", { status: 432 }));

    await expect(searchWeb({ query: "example" })).rejects.toThrow(
      "Tavily quota exhausted: plan or API key limit reached (HTTP 432): monthly limit reached",
    );
  });

  test("cancels an active Tavily request from the caller signal", async () => {
    const controller = new AbortController();
    let requestStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    useMockFetch(async (_input, init) => {
      requestStarted();
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
      return new Response("unreachable");
    });

    const pending = searchWeb({ query: "example" }, controller.signal);
    await started;
    controller.abort();

    await expect(pending).rejects.toThrow("aborted");
  });
});
