import { obj, type Static, str } from "@earendil-works/pi-schema";
import { createToolDefinition } from "../definition";

export const SAutomationDeleteArgs = obj({
  name: str({ minLength: 1, description: "Exact name of the saved automation to delete" }),
});

export type TAutomationDeleteArgs = Static<typeof SAutomationDeleteArgs>;

export const AUTOMATION_DELETE_TOOL = "automation-delete";

export const automationDeleteTool = createToolDefinition(
  AUTOMATION_DELETE_TOOL,
  "Delete a saved automation and remove it from cron jobs. Returns the jobs that were updated or cancelled because of it.",
  SAutomationDeleteArgs,
);
