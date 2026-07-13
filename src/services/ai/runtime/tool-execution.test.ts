import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CronSingleton } from "../../cron";
import { resetCronEngineJobsTable } from "../../database/test-utils";
import { DefaultConfigRecord } from "../../settings/schema";
import { DEFINE_MESSAGE_IMPORTANCE_TOOL } from "../tools/define-message-importance/definition";
import { LIST_CRON_JOBS_TOOL } from "../tools/list-cron-jobs/definition";
import { SCHEDULE_RECURRING_TOOL } from "../tools/schedule-recurring/definition";
import type { TToolCall } from "../types";
import { executeToolCall } from "./tool-execution";

type TCronSingletonStatic = {
  _instance: CronSingleton | undefined;
};

function cleanupCronSingleton() {
  const CronSingletonWithInternals = CronSingleton as unknown as TCronSingletonStatic;
  CronSingletonWithInternals._instance?.destroy();
}

function createToolCall(id: string, name: string, toolArguments: unknown): TToolCall {
  return {
    id,
    name,
    arguments: toolArguments,
  };
}

describe("executeToolCall", () => {
  beforeEach(async () => {
    cleanupCronSingleton();
    await resetCronEngineJobsTable();
  });

  afterEach(() => {
    cleanupCronSingleton();
  });

  test("returns parsed data for local validation-only tools", async () => {
    const toolCall = createToolCall("importance-call", DEFINE_MESSAGE_IMPORTANCE_TOOL, {
      importance: "high",
      reasoning: "contains durable context",
    });

    const result = await executeToolCall({
      toolCall,
      chatId: undefined,
      allowedToolNames: new Set([DEFINE_MESSAGE_IMPORTANCE_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(result).toEqual({
      toolCallId: "importance-call",
      toolName: DEFINE_MESSAGE_IMPORTANCE_TOOL,
      success: true,
      data: { importance: "high", reasoning: "contains durable context" },
      error: undefined,
    });
  });

  test("normalizes invalid arguments and unknown tool failures", async () => {
    const invalidArguments = await executeToolCall({
      toolCall: createToolCall("bad-arguments", DEFINE_MESSAGE_IMPORTANCE_TOOL, "invalid"),
      chatId: undefined,
      allowedToolNames: new Set([DEFINE_MESSAGE_IMPORTANCE_TOOL]),
      settings: DefaultConfigRecord,
    });
    const unknownTool = await executeToolCall({
      toolCall: createToolCall("unknown", "unknown-tool", {}),
      chatId: undefined,
      allowedToolNames: new Set([DEFINE_MESSAGE_IMPORTANCE_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(invalidArguments).toMatchObject({
      toolCallId: "bad-arguments",
      toolName: DEFINE_MESSAGE_IMPORTANCE_TOOL,
      success: false,
    });
    expect(invalidArguments.error).toContain("Arguments validation failed");
    expect(unknownTool).toEqual({
      toolCallId: "unknown",
      toolName: "unknown-tool",
      success: false,
      data: undefined,
      error: "Unknown tool requested: unknown-tool",
    });
  });

  test("requires chatId for cron tools", async () => {
    const result = await executeToolCall({
      toolCall: createToolCall("list-cron", LIST_CRON_JOBS_TOOL, {}),
      chatId: undefined,
      allowedToolNames: new Set([LIST_CRON_JOBS_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(result).toEqual({
      toolCallId: "list-cron",
      toolName: LIST_CRON_JOBS_TOOL,
      success: false,
      data: undefined,
      error: `chatId is required for tool: ${LIST_CRON_JOBS_TOOL}`,
    });
  });

  test("runs real cron schedule and list tool handlers", async () => {
    const chatId = "runtime-cron-user";
    const scheduleResult = await executeToolCall({
      toolCall: createToolCall("schedule-cron", SCHEDULE_RECURRING_TOOL, {
        name: "drink-water",
        pattern: "0 9 * * *",
        group: "health",
        reminderPromptData: '{"topic":"hydration"}',
        reminderFallbackText: "Drink water.",
      }),
      chatId,
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL, LIST_CRON_JOBS_TOOL]),
      settings: DefaultConfigRecord,
    });
    const listResult = await executeToolCall({
      toolCall: createToolCall("list-cron", LIST_CRON_JOBS_TOOL, {}),
      chatId,
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL, LIST_CRON_JOBS_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(scheduleResult.success).toBe(true);
    expect(scheduleResult.data).toMatchObject({
      name: "drink-water",
      scope: chatId,
      pattern: "0 9 * * *",
      group: "health",
      reminderText: undefined,
      reminderPromptData: '{"topic":"hydration"}',
      reminderFallbackText: "Drink water.",
    });
    expect(listResult.success).toBe(true);
    expect(listResult.data).toMatchObject([
      {
        name: "drink-water",
        scope: chatId,
        pattern: "0 9 * * *",
        group: "health",
        reminderText: undefined,
        reminderPromptData: '{"topic":"hydration"}',
        reminderFallbackText: "Drink water.",
      },
    ]);
  });

  test("rejects generated reminder args without fallback text", async () => {
    const result = await executeToolCall({
      toolCall: createToolCall("schedule-cron-invalid", SCHEDULE_RECURRING_TOOL, {
        name: "drink-water",
        pattern: "0 9 * * *",
        reminderPromptData: '{"topic":"hydration"}',
      }),
      chatId: "runtime-cron-user",
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("reminderFallbackText is required");
  });
});
