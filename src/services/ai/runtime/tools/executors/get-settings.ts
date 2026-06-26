import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { TOption } from "../../../../../types";
import { SettingsService } from "../../../../settings";
import { SGetSettingsArgs } from "../../../tools/get-settings/handler";
import { normalizeError } from "../../serialization";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { requireChatId } from "../context";
import { createFailedToolResult, createSuccessfulToolResult } from "../results";

export async function executeGetSettingsTool(
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

  const parsed = parseAndValidateToolArgs(toolCall, SGetSettingsArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  try {
    const settings = await SettingsService.instance.getAll(resolvedChatId);
    return createSuccessfulToolResult(toolCall, { settings });
  } catch (error) {
    return createFailedToolResult(toolCall, `get-settings failed: ${normalizeError(error)}`);
  }
}
