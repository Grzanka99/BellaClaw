import { type Static, Type } from "@earendil-works/pi-ai";
import { EAiProvider, EModelPurpose } from "../../types";

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
    aiModel: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Exact Pi model ID from the active or simultaneously requested provider",
      }),
    ),
    aiModelPurpose: Type.Optional(
      Type.Enum(EModelPurpose, {
        description: "Model purpose to change. Defaults to Main when omitted",
      }),
    ),
    aiReasoningEffort: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ]),
    ),
    resetAiModel: Type.Optional(
      Type.Boolean({ description: "Reset the selected purpose to the provider registry default" }),
    ),
    resetAiReasoningEffort: Type.Optional(
      Type.Boolean({ description: "Reset reasoning effort while keeping the selected model" }),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);

export type TUpdateSettingsArgs = Static<typeof SUpdateSettingsArgs>;

export function validateUpdateSettingsArgs(args: TUpdateSettingsArgs): void {
  const hasModelOperation =
    args.aiModel !== undefined ||
    args.aiReasoningEffort !== undefined ||
    args.resetAiModel === true ||
    args.resetAiReasoningEffort === true;

  if (args.aiModelPurpose !== undefined && !hasModelOperation) {
    throw new Error("aiModelPurpose requires a model or reasoning-effort change");
  }

  if (
    args.resetAiModel === true &&
    (args.aiModel !== undefined ||
      args.aiReasoningEffort !== undefined ||
      args.resetAiReasoningEffort === true)
  ) {
    throw new Error("resetAiModel cannot be combined with another model change");
  }

  if (args.resetAiReasoningEffort === true && args.aiReasoningEffort !== undefined) {
    throw new Error("Choose aiReasoningEffort or resetAiReasoningEffort, not both");
  }
}
