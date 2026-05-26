import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchWeb } from "../../runtime/tools/executors/web-fetch";

const originalFetch = globalThis.fetch;

type TMockFetch = (input: Parameters<typeof fetch>[0]) => Promise<Response>;

function useMockFetch(handler: TMockFetch) {
  globalThis.fetch = handler as typeof fetch;
}

describe("fetchWeb", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns raw HTML for html format", async () => {
    useMockFetch(
      async () =>
        new Response("<html><body><h1>Hello</h1></body></html>", {
          headers: { "content-type": "text/html" },
        }),
    );

    const result = await fetchWeb({ url: "https://example.com/page", format: "html" });

    expect(result).toMatchObject({
      url: "https://example.com/page",
      contentType: "text/html",
      format: "html",
      content: "<html><body><h1>Hello</h1></body></html>",
      truncated: false,
    });
  });

  test("extracts visible text for text format", async () => {
    useMockFetch(
      async () =>
        new Response("<body><h1>Hello</h1><script>hidden()</script><p>World</p></body>", {
          headers: { "content-type": "text/html" },
        }),
    );

    const result = await fetchWeb({ url: "https://example.com/page", format: "text" });

    expect(result.content).toBe("Hello World");
    expect(result.format).toBe("text");
  });

  test("converts HTML to markdown by default", async () => {
    useMockFetch(
      async () =>
        new Response("<body><h1>Hello</h1><p>World</p></body>", {
          headers: { "content-type": "text/html" },
        }),
    );

    const result = await fetchWeb({ url: "https://example.com/page" });

    expect(result.format).toBe("markdown");
    expect(result.content).toContain("Hello");
    expect(result.content).toContain("World");
    expect(result.content).not.toContain("<h1>");
  });

  test("fails on non-2xx responses", async () => {
    useMockFetch(async () => new Response("missing", { status: 404 }));

    await expect(fetchWeb({ url: "https://example.com/missing" })).rejects.toThrow(
      "HTTP request failed with status 404",
    );
  });

  test("fails on oversized responses", async () => {
    useMockFetch(
      async () => new Response("too large", { headers: { "content-length": "5000001" } }),
    );

    await expect(fetchWeb({ url: "https://example.com/large" })).rejects.toThrow(
      "Response is too large",
    );
  });

  test("truncates formatted output", async () => {
    useMockFetch(
      async () => new Response("a".repeat(80_001), { headers: { "content-type": "text/plain" } }),
    );

    const result = await fetchWeb({ url: "https://example.com/long", format: "html" });

    expect(result.content).toHaveLength(80_000);
    expect(result.truncated).toBe(true);
  });

  test("blocks local and private URLs before fetching", async () => {
    let called = false;
    useMockFetch(async () => {
      called = true;
      return new Response("should not fetch");
    });

    await expect(fetchWeb({ url: "http://127.0.0.1/page" })).rejects.toThrow(
      "Local or private IP literal URLs are blocked",
    );
    expect(called).toBe(false);
  });

  test("blocks redirect targets to local and private URLs", async () => {
    useMockFetch(
      async () =>
        new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        }),
    );

    await expect(fetchWeb({ url: "https://example.com/redirect" })).rejects.toThrow(
      "Local or private IP literal URLs are blocked",
    );
  });

  test("fails after redirect limit", async () => {
    let redirects = 0;
    useMockFetch(async () => {
      redirects += 1;
      return new Response("", {
        status: 302,
        headers: { location: `https://example.com/redirect-${redirects}` },
      });
    });

    await expect(fetchWeb({ url: "https://example.com/redirect" })).rejects.toThrow(
      "Too many redirects",
    );
    expect(redirects).toBe(6);
  });
});
