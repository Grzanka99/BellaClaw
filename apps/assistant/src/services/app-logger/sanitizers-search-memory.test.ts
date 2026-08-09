import { describe, expect, test } from "bun:test";
import { sanitizeToolCallArguments, sanitizeToolResult } from "./sanitizers";

describe("search-memory log sanitizers", () => {
  test("logs semantic query length and limit without query content", () => {
    const query = "favorite bicycle name";
    const result = sanitizeToolCallArguments({
      id: "call-1",
      name: "search-memory",
      arguments: { query, limit: 4 },
    });

    expect(result).toEqual({
      summary: `search-memory args queryChars=${query.length}`,
      metadata: {
        argumentsValid: true,
        queryChars: query.length,
        limit: 4,
      },
    });
    expect(JSON.stringify(result)).not.toContain(query);
  });

  test("omits queryChars when the query is not a string", () => {
    const result = sanitizeToolCallArguments({
      id: "call-2",
      name: "search-memory",
      arguments: {},
    });

    expect(result.metadata).not.toHaveProperty("queryChars");
    expect(result.metadata).not.toHaveProperty("limit");
  });

  test("counts returned facts", () => {
    const result = sanitizeToolResult({
      toolCallId: "call-1",
      toolName: "search-memory",
      success: true,
      data: {
        facts: [{ id: 1 }, { id: 2 }, { id: 3 }],
      },
      error: undefined,
    });

    expect(result).toEqual({
      summary: "search-memory returned 3 facts",
      metadata: {
        status: "completed",
        resultCount: 3,
      },
    });
  });

  test("reports zero when returned facts are absent", () => {
    const result = sanitizeToolResult({
      toolCallId: "call-1",
      toolName: "search-memory",
      success: true,
      data: {},
      error: undefined,
    });

    expect(result).toEqual({
      summary: "search-memory returned 0 facts",
      metadata: {
        status: "completed",
        resultCount: 0,
      },
    });
  });
});
