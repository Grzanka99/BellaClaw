import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { CronSingleton } from "../../cron";
import { DEFINE_MESSAGE_IMPORTANCE_TOOL } from "../tools/define-message-importance/definition";
import { LIST_CRON_JOBS_TOOL } from "../tools/list-cron-jobs/definition";
import { SCHEDULE_RECURRING_TOOL } from "../tools/schedule-recurring/definition";
import { executeToolCall } from "./tool-execution";

const tempDir = join(Bun.cwd, "tmp");
mkdirSync(tempDir, { recursive: true });
const TEST_DB = join(tempDir, "test-ai-runtime-tool-execution.db");

type TCronSingletonStatic = {
  _instance: CronSingleton | undefined;
};

function cleanupCronSingleton() {
  const CronSingletonWithInternals = CronSingleton as unknown as TCronSingletonStatic;
  CronSingletonWithInternals._instance?.destroy();
  CronSingleton.resetDbFile();
}

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

describe("executeToolCall", () => {
  beforeEach(() => {
    cleanupCronSingleton();

    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }

    CronSingleton.setDbFile(TEST_DB);
  });

  afterEach(() => {
    cleanupCronSingleton();

    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
  });

  test("returns parsed data for local validation-only tools", async () => {
    const toolCall = createToolCall(
      "importance-call",
      DEFINE_MESSAGE_IMPORTANCE_TOOL,
      JSON.stringify({ importance: "high", reasoning: "contains durable context" }),
    );

    const result = await executeToolCall({
      toolCall,
      chatId: undefined,
      allowedToolNames: new Set([DEFINE_MESSAGE_IMPORTANCE_TOOL]),
    });

    expect(result).toEqual({
      toolCallId: "importance-call",
      toolName: DEFINE_MESSAGE_IMPORTANCE_TOOL,
      success: true,
      data: { importance: "high", reasoning: "contains durable context" },
      error: undefined,
    });
  });

  test("normalizes invalid JSON and unknown tool failures", async () => {
    const invalidJson = await executeToolCall({
      toolCall: createToolCall("bad-json", DEFINE_MESSAGE_IMPORTANCE_TOOL, "{"),
      chatId: undefined,
      allowedToolNames: new Set([DEFINE_MESSAGE_IMPORTANCE_TOOL]),
    });
    const unknownTool = await executeToolCall({
      toolCall: createToolCall("unknown", "unknown-tool", "{}"),
      chatId: undefined,
      allowedToolNames: new Set([DEFINE_MESSAGE_IMPORTANCE_TOOL]),
    });

    expect(invalidJson).toMatchObject({
      toolCallId: "bad-json",
      toolName: DEFINE_MESSAGE_IMPORTANCE_TOOL,
      success: false,
    });
    expect(invalidJson.error).toContain("Invalid JSON arguments");
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
      toolCall: createToolCall("list-cron", LIST_CRON_JOBS_TOOL, "{}"),
      chatId: undefined,
      allowedToolNames: new Set([LIST_CRON_JOBS_TOOL]),
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
      toolCall: createToolCall(
        "schedule-cron",
        SCHEDULE_RECURRING_TOOL,
        JSON.stringify({
          name: "drink-water",
          pattern: "0 9 * * *",
          group: "health",
          reminderPromptData: '{"topic":"hydration"}',
          reminderFallbackText: "Drink water.",
        }),
      ),
      chatId,
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL, LIST_CRON_JOBS_TOOL]),
    });
    const listResult = await executeToolCall({
      toolCall: createToolCall("list-cron", LIST_CRON_JOBS_TOOL, "{}"),
      chatId,
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL, LIST_CRON_JOBS_TOOL]),
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
      toolCall: createToolCall(
        "schedule-cron-invalid",
        SCHEDULE_RECURRING_TOOL,
        JSON.stringify({
          name: "drink-water",
          pattern: "0 9 * * *",
          reminderPromptData: '{"topic":"hydration"}',
        }),
      ),
      chatId: "runtime-cron-user",
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL]),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("reminderFallbackText is required");
  });
});
