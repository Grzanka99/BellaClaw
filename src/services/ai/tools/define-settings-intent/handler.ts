import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { z } from "zod";
import type { TOption } from "../../../../types";
import { logger } from "../../../../utils/logger";

export const SDefineSettingsIntent = z.object({
  intent: z.enum(["settings", "normal"]),
  reason: z.string(),
});

export type TDefineSettingsIntent = z.infer<typeof SDefineSettingsIntent>;

export function handleDefineSettingsIntent(
  toolCall: ChatMessageToolCall,
): TOption<TDefineSettingsIntent> {
  let argsJson: unknown;
  try {
    argsJson = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    logger.error(`Failed to parse define-settings-intent arguments: ${String(error)}`);
    return undefined;
  }

  const parsed = SDefineSettingsIntent.safeParse(argsJson);

  if (!parsed.success) {
    logger.error("handleDefineSettingsIntent: Zod validation failed");
    return undefined;
  }

  return parsed.data;
}
