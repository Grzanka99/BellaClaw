import { z } from "zod";
import type { TOption } from "../../../../../types";
import { SettingsService } from "../../../../settings";
import { EConfigKey } from "../../../../settings/schema";
import { getAiModelIds } from "../../../providers/registry";
import { SGetSettingsArgs } from "../../../tools/get-settings/handler";
import { EAiProvider, type TToolCall } from "../../../types";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { requireChatId } from "../context";
import {
  createFailedToolResult,
  createInternalToolFailure,
  createSuccessfulToolResult,
} from "../results";

export async function executeGetSettingsTool(
  toolCall: TToolCall,
  chatId: TOption<string>,
): Promise<TNormalizedToolResult> {
  const resolvedChatId = requireChatId(toolCall, chatId);

  if (resolvedChatId === undefined) {
    return createFailedToolResult(toolCall, `chatId is required for tool: ${toolCall.name}`);
  }

  const parsed = parseAndValidateToolArgs(toolCall, SGetSettingsArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  try {
    const settings = await SettingsService.instance.getAll(resolvedChatId);
    const providerParse = z.enum(EAiProvider).safeParse(settings[EConfigKey.AiProvider]);

    if (!providerParse.success) {
      return createFailedToolResult(toolCall, "get-settings failed: invalid configured provider");
    }

    const provider = providerParse.data;
    const models = getAiModelIds(provider);

    return createSuccessfulToolResult(toolCall, {
      settings,
      aiRuntime: {
        provider,
        models,
      },
    });
  } catch (error) {
    return createInternalToolFailure(toolCall, "read settings", error);
  }
}
