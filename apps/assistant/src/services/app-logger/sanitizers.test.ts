import { describe, expect, test } from "bun:test";
import { createCalendarEvent } from "../ai/tools/create-calendar-event";
import { rememberMemory } from "../ai/tools/remember-memory";
import { scheduleOnce } from "../ai/tools/schedule-once";
import { updateSettings } from "../ai/tools/update-settings";
import { webSearch } from "../ai/tools/web-search";
import { sanitizeToolCallArguments, sanitizeToolResult } from "./sanitizers";

function completed(toolName: string, data: unknown) {
  return { toolCallId: "call-1", toolName, success: true, data, error: undefined };
}

describe("generic tool log shape", () => {
  test("logs string lengths, array counts and only allowlisted values", () => {
    const result = sanitizeToolCallArguments(
      "example",
      {
        query: "private query",
        ids: [1, 2, 3],
        limit: 4,
        flag: true,
        hidden: 7,
        mode: "fast",
        nested: { secret: "private" },
      },
      { logSafe: ["limit", "flag", ["mode", "speed"]], privateErrors: false },
    );

    expect(result).toEqual({
      summary: "example args queryChars=13 idsCount=3 limit=4 flag=true speed=fast",
      metadata: { queryChars: 13, idsCount: 3, limit: 4, flag: true, speed: "fast" },
    });
  });

  test("logs keys of an allowlisted nested record and ISO dates", () => {
    const result = sanitizeToolResult(
      completed("example", {
        settings: { timezone: "Europe/Warsaw", language: "Polish" },
        nextRunAt: new Date("2026-01-01T10:00:00.000Z"),
      }),
      { logSafe: [["settings", "settingKeys"], "nextRunAt"], privateErrors: false },
    );

    expect(result.metadata).toEqual({
      status: "completed",
      settingKeys: ["timezone", "language"],
      nextRunAt: "2026-01-01T10:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("Europe/Warsaw");
  });

  test("counts array results and describes other result kinds", () => {
    expect(sanitizeToolResult(completed("example", [{}, {}]), undefined).metadata).toEqual({
      status: "completed",
      resultCount: 2,
    });
    expect(sanitizeToolResult(completed("example", "private text"), undefined)).toEqual({
      summary: "example completed dataKind=string",
      metadata: { status: "completed", dataKind: "string" },
    });
  });
});

describe("tool log privacy", () => {
  test.each([
    {
      name: "remember-memory",
      policy: rememberMemory,
      args: { fact: "private fact", sourceMessage: "private message", supersedesFactIds: [1] },
      data: { rememberedFactId: 9 },
    },
    {
      name: "schedule-once",
      policy: scheduleOnce,
      args: {
        name: "private-job",
        fireAt: "2026-01-01T10:00",
        group: "private-group",
        taskPrompt: "private task",
        taskFallbackText: "private fallback",
      },
      data: {
        id: 1,
        name: "private-job",
        scope: "discord:private-chat",
        group: "private-group",
        type: "once",
        taskPrompt: "private task",
        taskFallbackText: "private fallback",
        nextRunAt: new Date("2026-01-01T09:00:00.000Z"),
      },
    },
    {
      name: "create-calendar-event",
      policy: createCalendarEvent,
      args: {
        summary: "private event",
        description: "private description",
        location: "private location",
        start: "2026-01-01T10:00:00+01:00",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      },
      data: { id: "private-event-id", htmlLink: "https://calendar.example/private?eid=x" },
    },
    {
      name: "web-search",
      policy: webSearch,
      args: { query: "private query", topic: "news", maxResults: 3 },
      data: {
        query: "private query",
        results: [{ url: "https://example.com/private?q=secret", content: "private page" }],
      },
    },
    {
      name: "update-settings",
      policy: updateSettings,
      args: { assistantName: "private name" },
      data: { settings: { assistantName: "private name" }, change: { purpose: "private" } },
    },
    {
      name: "delegate-memory",
      policy: undefined,
      args: { task: "private task" },
      data: { text: "private response", stopReason: "completed" },
    },
    {
      name: "mcp-search-issues",
      policy: undefined,
      args: { query: "private query", page: 2, filters: { owner: "private" } },
      data: { content: [{ type: "text", text: "private result" }], isError: false },
    },
  ])("$name records hide private values", ({ name, policy, args, data }) => {
    const serialized = JSON.stringify([
      sanitizeToolCallArguments(name, args, policy),
      sanitizeToolResult(completed(name, data), policy),
    ]);

    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("https://");
  });

  test("keeps bounded previews for preview fields while redacting secrets", () => {
    const previousKey = Bun.env.OPENROUTER_API_KEY;
    Bun.env.OPENROUTER_API_KEY = "super-secret";
    const policy = { logSafe: [], privateErrors: false, previews: ["task", "text"] };
    const args = sanitizeToolCallArguments(
      "delegate-memory",
      { task: `summarize super-secret ${"detail ".repeat(80)}` },
      policy,
    );
    const result = sanitizeToolResult(
      completed("delegate-memory", { text: `Found super-secret ${"memory ".repeat(80)}` }),
      policy,
    );
    if (previousKey === undefined) {
      delete Bun.env.OPENROUTER_API_KEY;
    } else {
      Bun.env.OPENROUTER_API_KEY = previousKey;
    }
    const serialized = JSON.stringify({ args, result });

    expect(serialized).toContain("summarize");
    expect(serialized).toContain("Found");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("super-secret");
    expect(args.metadata.taskPreview).toEndWith("...");
    expect(result.metadata.textPreview).toEndWith("...");
    expect(args.summary).toBe(`delegate-memory args taskChars=${23 + 7 * 80}`);
  });

  test("keeps searchable cron metadata", () => {
    const result = sanitizeToolCallArguments(
      "schedule-recurring",
      { name: "daily", pattern: "0 9 * * *", overwrite: true },
      { logSafe: ["overwrite", ["pattern", "cronPattern"]], privateErrors: true },
    );

    expect(result.metadata).toEqual({ nameChars: 5, cronPattern: "0 9 * * *", overwrite: true });
  });
});
