import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { ECronEngineJobType } from "../../../../../lib/cron-engine";
import type { TOption } from "../../../../../types";
import { CronSingleton } from "../../../../cron";
import {
  SUpdateCronJobArgs,
  type TUpdateCronJobArgs,
} from "../../../tools/update-cron-job/handler";
import { normalizeError } from "../../serialization";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { requireChatId } from "../context";
import { serializeCronJobForModel } from "../cron-serialization";
import { createFailedToolResult, createSuccessfulToolResult } from "../results";

export async function executeUpdateCronJobTool(
  toolCall: ChatMessageToolCall,
  chatId: TOption<string>,
  ownerTimezone: string,
): Promise<TNormalizedToolResult> {
  const resolvedChatId = requireChatId(toolCall, chatId);

  if (resolvedChatId === undefined) {
    return createFailedToolResult(
      toolCall,
      `chatId is required for tool: ${toolCall.function.name}`,
    );
  }

  const parsed = parseAndValidateToolArgs<TUpdateCronJobArgs>(toolCall, SUpdateCronJobArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  const existing = await CronSingleton.instance.getJob(parsed.data.name, resolvedChatId);

  if (existing === undefined) {
    return createFailedToolResult(toolCall, `No job found with name: ${parsed.data.name}`);
  }

  let reminderText: TOption<string> = existing.reminderText;
  let reminderPromptData: TOption<string> = existing.reminderPromptData;
  let reminderFallbackText: TOption<string> = existing.reminderFallbackText;

  if (parsed.data.reminderText !== undefined) {
    reminderText = parsed.data.reminderText;
    reminderPromptData = undefined;
    reminderFallbackText = undefined;
  } else if (parsed.data.reminderPromptData !== undefined) {
    reminderText = undefined;
    reminderPromptData = parsed.data.reminderPromptData;
    reminderFallbackText = parsed.data.reminderFallbackText;
  }

  if (existing.type === ECronEngineJobType.Recurring) {
    if (parsed.data.fireAt !== undefined) {
      return createFailedToolResult(
        toolCall,
        "fireAt can only update one-time reminders; use pattern for recurring reminders",
      );
    }

    const pattern = parsed.data.pattern ?? existing.pattern;

    if (pattern === undefined) {
      return createFailedToolResult(toolCall, "Existing recurring reminder has no pattern");
    }

    const result = await CronSingleton.instance.schedule({
      name: existing.name,
      scope: resolvedChatId,
      group: parsed.data.group ?? existing.group,
      pattern,
      reminderText,
      reminderPromptData,
      reminderFallbackText,
      overwrite: true,
      timezone: existing.timezone ?? ownerTimezone,
    });

    if ("error" in result) {
      return createFailedToolResult(
        toolCall,
        `update-cron-job failed during ${result.operation}: ${normalizeError(result.error)}`,
      );
    }

    return createSuccessfulToolResult(toolCall, serializeCronJobForModel(result, ownerTimezone));
  }

  if (parsed.data.pattern !== undefined) {
    return createFailedToolResult(
      toolCall,
      "pattern can only update recurring reminders; use fireAt for one-time reminders",
    );
  }

  const result = await CronSingleton.instance.scheduleOnce({
    name: existing.name,
    scope: resolvedChatId,
    group: parsed.data.group ?? existing.group,
    fireAt: parsed.data.fireAt ?? existing.nextRunAt,
    reminderText,
    reminderPromptData,
    reminderFallbackText,
    overwrite: true,
    timezone: existing.timezone ?? ownerTimezone,
  });

  if ("error" in result) {
    return createFailedToolResult(
      toolCall,
      `update-cron-job failed during ${result.operation}: ${normalizeError(result.error)}`,
    );
  }

  return createSuccessfulToolResult(toolCall, serializeCronJobForModel(result, ownerTimezone));
}
