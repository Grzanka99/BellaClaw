import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { TOption } from "../../../../../types";
import { invalidateMessageHandlerInstructions } from "../../../../message-handler/instructions";
import { SettingsService } from "../../../../settings";
import { ConfigValidators, EConfigKey } from "../../../../settings/schema";
import {
  SUpdateSettingsArgs,
  type TUpdateSettingsArgs,
} from "../../../tools/update-settings/handler";
import { normalizeError } from "../../serialization";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { requireChatId } from "../context";
import { createFailedToolResult, createSuccessfulToolResult } from "../results";

type TFieldUpdate = {
  field: keyof TUpdateSettingsArgs;
  key: EConfigKey;
  value: string;
};

export async function executeUpdateSettingsTool(
  toolCall: ChatMessageToolCall,
  chatId: TOption<string>,
): Promise<TNormalizedToolResult> {
  const resolvedChatId = requireChatId(toolCall, chatId);

  if (resolvedChatId === undefined) {
    return createFailedToolResult(
      toolCall,
      `chatId is required for tool: ${toolCall.function.name}`,
    );
  }

  const parsed = parseAndValidateToolArgs<TUpdateSettingsArgs>(toolCall, SUpdateSettingsArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  const updates = collectUpdates(parsed.data);

  if (updates.length === 0) {
    return createFailedToolResult(toolCall, "Provide at least one field to update");
  }

  const validationErrors = validateUpdates(updates);

  if (validationErrors.length > 0) {
    return createFailedToolResult(toolCall, validationErrors.join("; "));
  }

  try {
    for (const update of updates) {
      await SettingsService.instance.set(resolvedChatId, update.key, update.value);
    }

    invalidateMessageHandlerInstructions(resolvedChatId);

    const settings = await SettingsService.instance.getAll(resolvedChatId);

    return createSuccessfulToolResult(toolCall, {
      updatedFields: updates.map((u) => ({
        field: u.field,
        key: u.key,
        value: u.value,
      })),
      settings,
    });
  } catch (error) {
    return createFailedToolResult(toolCall, `update-settings failed: ${normalizeError(error)}`);
  }
}

function collectUpdates(args: TUpdateSettingsArgs): TFieldUpdate[] {
  const updates: TFieldUpdate[] = [];

  if (args.timezone !== undefined) {
    updates.push({
      field: "timezone",
      key: EConfigKey.AiInstructionsTimezone,
      value: args.timezone,
    });
  }

  if (args.language !== undefined) {
    updates.push({
      field: "language",
      key: EConfigKey.AiInstructionsLanguage,
      value: args.language,
    });
  }

  if (args.assistantName !== undefined) {
    updates.push({
      field: "assistantName",
      key: EConfigKey.AiInstructionsAssistantName,
      value: args.assistantName,
    });
  }

  if (args.addressStyle !== undefined) {
    updates.push({
      field: "addressStyle",
      key: EConfigKey.AiInstructionsAddressStyle,
      value: args.addressStyle,
    });
  }

  if (args.preferredReplyLength !== undefined) {
    updates.push({
      field: "preferredReplyLength",
      key: EConfigKey.AiInstructionsPreferredReplyLength,
      value: args.preferredReplyLength,
    });
  }

  if (args.aiProvider !== undefined) {
    updates.push({ field: "aiProvider", key: EConfigKey.AiProvider, value: args.aiProvider });
  }

  return updates;
}

function validateUpdates(updates: TFieldUpdate[]): string[] {
  const errors: string[] = [];

  for (const update of updates) {
    const validator = ConfigValidators[update.key];
    const parsed = validator.safeParse(update.value);

    if (!parsed.success) {
      errors.push(`Invalid value for ${update.field}: ${parsed.error.message}`);
    }
  }

  return errors;
}
