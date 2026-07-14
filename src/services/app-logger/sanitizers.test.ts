import { describe, expect, test } from "bun:test";
import { ECronJobStatus, ECronJobType } from "../../lib/cron-engine";
import { serializeCronJobForModel } from "../ai/runtime/tools/cron-serialization";
import type { TToolCall } from "../ai/types";
import { sanitizeToolCallArguments, sanitizeToolResult } from "./sanitizers";

function createToolCall(name: string, toolArguments: unknown): TToolCall {
  return {
    id: "tool-call-1",
    name,
    arguments: toolArguments,
  };
}

describe("app logger sanitizers", () => {
  test("summarizes cron arguments without reminder text", () => {
    const details = sanitizeToolCallArguments(
      createToolCall("schedule-recurring", {
        name: "hydration",
        pattern: "0 9 * * *",
        reminderText: "private reminder body",
        reminderPromptData: "private prompt payload",
        reminderFallbackText: "private fallback text",
        taskPrompt: "private task objective",
        taskFallbackText: "private task fallback",
      }),
    );
    const serialized = JSON.stringify(details);

    expect(serialized).toContain("nameChars");
    expect(serialized).toContain("0 9 * * *");
    expect(serialized).toContain("reminderTextChars");
    expect(serialized).not.toContain("hydration");
    expect(serialized).not.toContain("private reminder body");
    expect(serialized).not.toContain("private prompt payload");
    expect(serialized).not.toContain("private fallback text");
    expect(serialized).toContain("taskPromptChars");
    expect(serialized).not.toContain("private task objective");
    expect(serialized).not.toContain("private task fallback");
  });

  test("summarizes cron results without returned reminder content", () => {
    const details = sanitizeToolResult({
      toolCallId: "tool-call-1",
      toolName: "schedule-recurring",
      success: true,
      data: serializeCronJobForModel({
        id: 1,
        name: "hydration",
        scope: "discord:user-1",
        group: undefined,
        type: ECronJobType.Recurring,
        pattern: "0 9 * * *",
        status: ECronJobStatus.Active,
        nextRunAt: new Date("2026-07-12T10:00:00.000Z"),
        lastRunAt: undefined,
        createdAt: new Date("2026-07-01T10:00:00.000Z"),
        finishedAt: undefined,
        finishedReason: undefined,
        timezone: "Europe/Warsaw",
        reminderText: undefined,
        reminderPromptData: undefined,
        reminderFallbackText: undefined,
        taskPrompt: "private task objective",
        taskFallbackText: "private task fallback",
      }),
      error: undefined,
    });
    const serialized = JSON.stringify(details);

    expect(serialized).toContain("jobNameChars");
    expect(serialized).toContain("0 9 * * *");
    expect(serialized).toContain("2026-07-12T10:00:00.000Z");
    expect(serialized).not.toContain("hydration");
    expect(serialized).toContain('"contentMode":"task"');
    expect(serialized).toContain('"taskPromptChars":22');
    expect(serialized).toContain('"taskFallbackTextChars":21');
    expect(serialized).not.toContain("private task objective");
    expect(serialized).not.toContain("private task fallback");
  });

  test("summarizes web tools without full queries, URLs, or fetched content", () => {
    const searchDetails = sanitizeToolResult({
      toolCallId: "tool-call-1",
      toolName: "web-search",
      success: true,
      data: {
        query: "private medical search query",
        results: [
          {
            title: "Private title",
            url: "https://example.com/private/path?q=secret",
            content: "private result content",
            score: 0.9,
          },
        ],
      },
      error: undefined,
    });
    const fetchDetails = sanitizeToolResult({
      toolCallId: "tool-call-2",
      toolName: "web-fetch",
      success: true,
      data: {
        url: "https://example.com/private/path?q=secret",
        contentType: "text/html",
        format: "markdown",
        content: "private fetched content",
        truncated: false,
      },
      error: undefined,
    });
    const serialized = JSON.stringify({ searchDetails, fetchDetails });

    expect(serialized).toContain("example.com");
    expect(serialized).toContain("queryChars");
    expect(serialized).toContain("contentChars");
    expect(serialized).not.toContain("private medical search query");
    expect(serialized).not.toContain("/private/path");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("private result content");
    expect(serialized).not.toContain("private fetched content");
  });
});
