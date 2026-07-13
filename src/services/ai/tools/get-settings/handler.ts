import { z } from "zod";
import type { TOption } from "../../../../types";
import { logger } from "../../../../utils/logger";

export const SGetSettingsArgs = z.object({}).strict();

export type TGetSettingsArgs = z.infer<typeof SGetSettingsArgs>;

export function handleGetSettingsArgs(args: unknown): TOption<TGetSettingsArgs> {
  const parsed = SGetSettingsArgs.safeParse(args);

  if (!parsed.success) {
    logger.error(`handleGetSettingsArgs: Zod validation failed: ${parsed.error.message}`);
    return undefined;
  }

  return parsed.data;
}
