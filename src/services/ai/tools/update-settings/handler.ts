import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { z } from "zod";
import type { TOption } from "../../../../types";
import { logger } from "../../../../utils/logger";
import { EAiProvider } from "../../types";

const SNonEmptyString = z.string().min(1);

export const SUpdateSettingsArgs = z
  .object({
    timezone: SNonEmptyString.optional(),
    language: SNonEmptyString.optional(),
    assistantName: SNonEmptyString.optional(),
    addressStyle: SNonEmptyString.optional(),
    preferredReplyLength: SNonEmptyString.optional(),
    aiProvider: z.enum(EAiProvider).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide at least one field to update",
  });

export type TUpdateSettingsArgs = z.infer<typeof SUpdateSettingsArgs>;

export function handleUpdateSettingsArgs(
  toolCall: ChatMessageToolCall,
): TOption<TUpdateSettingsArgs> {
  let argsJson: unknown;
  try {
    argsJson = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    logger.error(`Failed to parse update-settings arguments: ${String(error)}`);
    return undefined;
  }

  const parsed = SUpdateSettingsArgs.safeParse(argsJson);

  if (!parsed.success) {
    logger.error(`handleUpdateSettingsArgs: Zod validation failed: ${parsed.error.message}`);
    return undefined;
  }

  return parsed.data;
}
