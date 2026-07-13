import { z } from "zod";
import type { TOption } from "../../../../types";
import { logger } from "../../../../utils/logger";

export const SDefineSettingsIntent = z.object({
  intent: z
    .enum(["settings", "normal"])
    .describe("The classified intent of the message: settings or normal"),
  reason: z.string().min(1).describe("Brief explanation in English of why this intent was chosen"),
});

export type TDefineSettingsIntent = z.infer<typeof SDefineSettingsIntent>;

export function handleDefineSettingsIntent(args: unknown): TOption<TDefineSettingsIntent> {
  const parsed = SDefineSettingsIntent.safeParse(args);

  if (!parsed.success) {
    logger.error(`handleDefineSettingsIntent: Zod validation failed: ${parsed.error.message}`);
    return undefined;
  }

  return parsed.data;
}
