import { describe, expect, mock, test } from "bun:test";
import { obj, type Schema } from "@earendil-works/pi-schema";
import { testEventRequester } from "../../events/test-utils";
import { DefaultConfigRecord } from "../../settings/schema";
import { defineTool, ToolError, validateToolArguments } from "./define-tool";
import { SScheduleOnceArgs } from "./schedule-once";
import { SSearchMemoryArgs } from "./search-memory";

describe("validateToolArguments", () => {
  test("names the offending path instead of throwing a bare Decode error", () => {
    const cases: Array<{ schema: Schema; args: unknown; path: string; reason: string }> = [
      {
        schema: SScheduleOnceArgs,
        args: { name: "x", fireAt: "tomorrow at 5pm", reminderText: "Reminder" },
        path: "/fireAt",
        reason: "expected to match",
      },
      {
        schema: SScheduleOnceArgs,
        args: {
          name: "x",
          fireAt: "2026-09-01T10:00:00",
          reminderText: "Reminder",
          taskPrompt: null,
        },
        path: "/taskPrompt",
        reason: "expected string, got null",
      },
      {
        schema: SSearchMemoryArgs,
        args: { query: "facts", limit: 99 },
        path: "/limit",
        reason: "expected <= 25",
      },
      {
        schema: SSearchMemoryArgs,
        args: {},
        path: "/query",
        reason: "missing",
      },
    ];

    for (const { schema, args, path, reason } of cases) {
      expect(() => validateToolArguments(schema, args)).toThrow(
        `Invalid tool arguments: ${path}: ${reason}`,
      );
    }
  });

  test("returns the decoded arguments for a valid payload", () => {
    expect(validateToolArguments(SSearchMemoryArgs, { query: "tea", limit: 3 })).toEqual({
      query: "tea",
      limit: 3,
    });
  });
});

describe("defineTool", () => {
  const context = {
    chatId: "discord:1",
    settings: DefaultConfigRecord,
    trace: { turnId: "test", chatId: undefined, platform: undefined },
    events: testEventRequester,
    verifySettings: mock(async () => undefined),
    runScheduledTask: mock(async () => {
      throw new Error("not used");
    }),
  };

  function failingTool(error: Error) {
    return defineTool({
      name: "failing",
      label: "Failing",
      description: "Fails",
      schema: obj({}),
      instructions: "",
      mode: "sequential",
      logSafe: [],
      execute: async () => {
        throw error;
      },
    }).createAgentTool(context);
  }

  test("returns a ToolError as an error result that carries its code", async () => {
    await expect(
      failingTool(new ToolError("job-not-found", "No job found with name: x")).execute("call", {}),
    ).resolves.toEqual({
      content: [{ type: "text", text: "No job found with name: x" }],
      details: { errorCode: "job-not-found" },
      isError: true,
    });
  });

  test("rethrows other errors", async () => {
    await expect(failingTool(new Error("boom")).execute("call", {})).rejects.toThrow("boom");
  });
});
