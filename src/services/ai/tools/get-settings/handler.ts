import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { z } from "zod";
import type { TOption } from "../../../../types";
import { logger } from "../../../../utils/logger";

export const SGetSettingsArgs = z.object({}).strict();

export type TGetSettingsArgs = z.infer<typeof SGetSettingsArgs>;

export function handleGetSettingsArgs(toolCall: ChatMessageToolCall): TOption<TGetSettingsArgs> {
  let argsJson: unknown;
  try {
    argsJson = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    logger.error(`Failed to parse get-settings arguments: ${String(error)}`);
    return undefined;
  }

  const parsed = SGetSettingsArgs.safeParse(argsJson);

  if (!parsed.success) {
    logger.error("handleGetSettingsArgs: Zod validation failed");
    return undefined;
  }

  return parsed.data;
}
