import { createToolDefinition } from "../definition";
import { SGetSettingsArgs } from "./handler";

export const GET_SETTINGS_TOOL = "get-settings" as const;

export const getSettingsTool = createToolDefinition(
  GET_SETTINGS_TOOL,
  "Reads the user's effective assistant settings and computed AI runtime provider/model mapping. Takes no arguments; the owner is determined automatically from the chat.",
  SGetSettingsArgs,
);
