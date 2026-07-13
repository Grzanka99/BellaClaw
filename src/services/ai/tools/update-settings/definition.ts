import { createToolDefinition } from "../definition";
import { SUpdateSettingsArgs } from "./handler";

export const UPDATE_SETTINGS_TOOL = "update-settings" as const;

export const updateSettingsTool = createToolDefinition(
  UPDATE_SETTINGS_TOOL,
  "Updates the user's assistant settings. Provide at least one field. Only provided fields change. For mixed settings and normal-task messages, apply the settings change and ask the user to resend the task separately.",
  SUpdateSettingsArgs,
);
