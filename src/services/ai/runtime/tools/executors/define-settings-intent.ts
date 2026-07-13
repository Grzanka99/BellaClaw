import {
  SDefineSettingsIntent,
  type TDefineSettingsIntent,
} from "../../../tools/define-settings-intent/handler";
import type { TToolCall } from "../../../types";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { createFailedToolResult, createSuccessfulToolResult } from "../results";

export async function executeDefineSettingsIntentTool(
  toolCall: TToolCall,
): Promise<TNormalizedToolResult> {
  const parsed = parseAndValidateToolArgs<TDefineSettingsIntent>(toolCall, SDefineSettingsIntent);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  return createSuccessfulToolResult(toolCall, parsed.data);
}
