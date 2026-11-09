import { obj, type Static } from "@earendil-works/pi-schema";
import { createToolDefinition } from "../definition";

export const SAutomationListArgs = obj({}, { description: "No arguments are required" });

export type TAutomationListArgs = Static<typeof SAutomationListArgs>;

export const AUTOMATION_LIST_TOOL = "automation-list";

export const automationListTool = createToolDefinition(
  AUTOMATION_LIST_TOOL,
  "List the saved automations in this chat with their status and last error, without source.",
  SAutomationListArgs,
);
