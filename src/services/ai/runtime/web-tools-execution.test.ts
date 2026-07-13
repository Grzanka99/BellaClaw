import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DefaultConfigRecord } from "../../settings/schema";
import { WEB_FETCH_TOOL } from "../tools/web-fetch/definition";
import { WEB_SEARCH_TOOL } from "../tools/web-search/definition";
import type { TToolCall } from "../types";
import { createToolResultMessage } from "./serialization";
import { executeToolCall } from "./tool-execution";

const originalFetch = globalThis.fetch;
const originalTavilyApiKey = Bun.env.TAVILY_API_KEY;

function createToolCall(id: string, name: string, toolArguments: unknown): TToolCall {
  return {
    id,
    name,
    arguments: toolArguments,
  };
}

describe("web tool execution", () => {
  beforeEach(() => {
    Bun.env.TAVILY_API_KEY = "test-key";
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      let url: string;

      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.href;
      } else {
        url = input.url;
      }

      if (url === "https://api.tavily.com/search") {
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "Result Title",
                url: "https://example.com/result",
                content: "Result content.",
                score: 0.82,
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      return new Response("<body><h1>Fetched Page</h1></body>", {
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalTavilyApiKey === undefined) {
      delete Bun.env.TAVILY_API_KEY;
    } else {
      Bun.env.TAVILY_API_KEY = originalTavilyApiKey;
    }

    globalThis.fetch = originalFetch;
  });

  test("executes web-search", async () => {
    const result = await executeToolCall({
      toolCall: createToolCall("search-call", WEB_SEARCH_TOOL, { query: "example", maxResults: 1 }),
      chatId: undefined,
      allowedToolNames: new Set([WEB_SEARCH_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(result).toMatchObject({
      toolCallId: "search-call",
      toolName: WEB_SEARCH_TOOL,
      success: true,
      data: {
        query: "example",
        results: [
          {
            title: "Result Title",
            url: "https://example.com/result",
            content: "Result content.",
            score: 0.82,
          },
        ],
      },
    });
  });

  test("executes web-fetch", async () => {
    const result = await executeToolCall({
      toolCall: createToolCall("fetch-call", WEB_FETCH_TOOL, {
        url: "https://example.com/page",
        format: "text",
      }),
      chatId: undefined,
      allowedToolNames: new Set([WEB_FETCH_TOOL]),
      settings: DefaultConfigRecord,
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
      toolCall: createToolCall("bad-search", WEB_SEARCH_TOOL, { query: "", maxResults: 1 }),
      chatId: undefined,
      allowedToolNames: new Set([WEB_SEARCH_TOOL]),
      settings: DefaultConfigRecord,
    });
    const fetchResult = await executeToolCall({
      toolCall: createToolCall("bad-fetch", WEB_FETCH_TOOL, { url: "ftp://example.com/file" }),
      chatId: undefined,
      allowedToolNames: new Set([WEB_FETCH_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(searchResult.success).toBe(false);
    expect(searchResult.error).toContain("Arguments validation failed");
    expect(fetchResult.success).toBe(false);
    expect(fetchResult.error).toContain("Arguments validation failed");
  });

  test("does not expose raw internal failures in provider-facing tool results", async () => {
    globalThis.fetch = (async () => {
      throw new Error(
        '400: {"metadata":{"raw":"private response body","reasoning":"private reasoning"}}',
      );
    }) as unknown as typeof fetch;

    const result = await executeToolCall({
      toolCall: createToolCall("private-failure", WEB_FETCH_TOOL, {
        url: "https://example.com/private",
      }),
      chatId: undefined,
      allowedToolNames: new Set([WEB_FETCH_TOOL]),
      settings: DefaultConfigRecord,
    });
    const providerMessage = createToolResultMessage(result);
    const serialized = JSON.stringify(providerMessage);

    expect(result.error).toBe("web-fetch failed during request");
    expect(serialized).not.toContain("private response body");
    expect(serialized).not.toContain("private reasoning");
  });
});
