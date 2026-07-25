import { createToolDefinition } from "../definition";
import { SUpdateSettingsArgs } from "./handler";

export const UPDATE_SETTINGS_TOOL = "update-settings" as const;

export const updateSettingsTool = createToolDefinition(
  UPDATE_SETTINGS_TOOL,
  "Updates the user's assistant settings. Provide at least one field; only provided fields change.",
  SUpdateSettingsArgs,
);
