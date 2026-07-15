import { z } from "zod";
import { EAiProvider } from "../../types";

const SNonEmptyString = z.string().trim().min(1);

export const SUpdateSettingsArgs = z
  .object({
    timezone: SNonEmptyString.describe(
      "Valid IANA timezone, such as Europe/Warsaw, America/New_York, or UTC",
    ).optional(),
    language: SNonEmptyString.describe(
      "Conversation language for assistant replies, such as Polish or English",
    ).optional(),
    assistantName: SNonEmptyString.describe("The assistant's display name").optional(),
    addressStyle: SNonEmptyString.describe("How the assistant should address the user").optional(),
    preferredReplyLength: SNonEmptyString.describe(
      "Preferred reply length, such as 1-3 sentences, short, or detailed",
    ).optional(),
    aiProvider: z
      .enum(EAiProvider)
      .describe("Active AI provider: openai-codex, openrouter, ollama, or opencode-go")
      .optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide at least one field to update",
  })
  .meta({ minProperties: 1 });

export type TUpdateSettingsArgs = z.infer<typeof SUpdateSettingsArgs>;
