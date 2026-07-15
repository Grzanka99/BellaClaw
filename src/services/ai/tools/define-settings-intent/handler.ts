import { z } from "zod";

export const SDefineSettingsIntent = z.object({
  intent: z
    .enum(["settings", "normal"])
    .describe("The classified intent of the message: settings or normal"),
  reason: z.string().min(1).describe("Brief explanation in English of why this intent was chosen"),
});

export type TDefineSettingsIntent = z.infer<typeof SDefineSettingsIntent>;
