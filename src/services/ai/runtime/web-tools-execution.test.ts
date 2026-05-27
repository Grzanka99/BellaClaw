import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { WEB_FETCH_TOOL } from "../tools/web-fetch/definition";
import { WEB_SEARCH_TOOL } from "../tools/web-search/definition";
import { executeToolCall } from "./tool-execution";

const originalFetch = globalThis.fetch;

function createToolCall(id: string, name: string, argumentsText: string): ChatMessageToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: argumentsText,
    },
  };
}

describe("web tool execution", () => {
  beforeEach(() => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      if (url.startsWith("https://html.duckduckgo.com/html/")) {
        return new Response(
          `
          <html><body>
            <a class="result__a" href="https://example.com/result">Result Title</a>
            <a class="result__snippet">Result snippet.</a>
          </body></html>
        `,
          { headers: { "content-type": "text/html" } },
        );
      }

      return new Response("<body><h1>Fetched Page</h1></body>", {
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("executes web-search", async () => {
    const result = await executeToolCall({
      toolCall: createToolCall(
        "search-call",
        WEB_SEARCH_TOOL,
        JSON.stringify({ query: "example", limit: 1 }),
      ),
      chatId: undefined,
      allowedToolNames: new Set([WEB_SEARCH_TOOL]),
    });

    expect(result).toMatchObject({
      toolCallId: "search-call",
      toolName: WEB_SEARCH_TOOL,
      success: true,
      data: {
        query: "example",
        results: [
          { title: "Result Title", url: "https://example.com/result", snippet: "Result snippet." },
        ],
      },
    });
  });

  test("executes web-fetch", async () => {
    const result = await executeToolCall({
      toolCall: createToolCall(
        "fetch-call",
        WEB_FETCH_TOOL,
        JSON.stringify({ url: "https://example.com/page", format: "text" }),
      ),
      chatId: undefined,
      allowedToolNames: new Set([WEB_FETCH_TOOL]),
    });

    expect(result).toMatchObject({
      toolCallId: "fetch-call",
      toolName: WEB_FETCH_TOOL,
      success: true,
      data: {
        url: "https://example.com/page",
        contentType: "text/html",
        format: "text",
        content: "Fetched Page",
        truncated: false,
      },
    });
  });

  test("handles validation failures", async () => {
    const searchResult = await executeToolCall({
      toolCall: createToolCall(
        "bad-search",
        WEB_SEARCH_TOOL,
        JSON.stringify({ query: "", limit: 1 }),
      ),
      chatId: undefined,
      allowedToolNames: new Set([WEB_SEARCH_TOOL]),
    });
    const fetchResult = await executeToolCall({
      toolCall: createToolCall(
        "bad-fetch",
        WEB_FETCH_TOOL,
        JSON.stringify({ url: "ftp://example.com/file" }),
      ),
      chatId: undefined,
      allowedToolNames: new Set([WEB_FETCH_TOOL]),
    });

    expect(searchResult.success).toBe(false);
    expect(searchResult.error).toContain("Arguments validation failed");
    expect(fetchResult.success).toBe(false);
    expect(fetchResult.error).toContain("Arguments validation failed");
  });
});
