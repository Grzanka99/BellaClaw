import { type Static, Type } from "@earendil-works/pi-ai";
import { EAiProvider } from "../../types";

export const SUpdateSettingsArgs = Type.Object(
  {
    timezone: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Valid IANA timezone, such as Europe/Warsaw, America/New_York, or UTC",
      }),
    ),
    language: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Conversation language for assistant replies, such as Polish or English",
      }),
    ),
    assistantName: Type.Optional(
      Type.String({ minLength: 1, description: "The assistant's display name" }),
    ),
    addressStyle: Type.Optional(
      Type.String({ minLength: 1, description: "How the assistant should address the user" }),
    ),
    preferredReplyLength: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Preferred reply length, such as 1-3 sentences, short, or detailed",
      }),
    ),
    aiProvider: Type.Optional(
      Type.Enum(EAiProvider, {
        description: "Active AI provider: openai-codex, openrouter, ollama, or opencode-go",
      }),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);

export type TUpdateSettingsArgs = Static<typeof SUpdateSettingsArgs>;
