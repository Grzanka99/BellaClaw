import { createToolDefinition } from "../definition";
import { SDefineSettingsIntent } from "./handler";

export const DEFINE_SETTINGS_INTENT_TOOL = "define-settings-intent" as const;

export const defineSettingsIntentTool = createToolDefinition(
  DEFINE_SETTINGS_INTENT_TOOL,
  "Classifies whether an incoming user message is a request to read or change assistant settings (intent=settings) or a normal conversational/task message (intent=normal). Returns the intent and a short reason. Call this tool exactly once for every incoming message.",
  SDefineSettingsIntent,
);
