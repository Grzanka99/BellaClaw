import { z } from "zod";

export const SGetSettingsArgs = z.object({}).strict();

export type TGetSettingsArgs = z.infer<typeof SGetSettingsArgs>;
