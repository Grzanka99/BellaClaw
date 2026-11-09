import { bool, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { createToolDefinition } from "../definition";

export const SAutomationGetArgs = obj({
  name: str({ minLength: 1, description: "Exact name of the saved automation" }),
  includeSource: opt(
    bool({ description: "Include the script source; only when editing or fixing the automation" }),
  ),
});

export type TAutomationGetArgs = Static<typeof SAutomationGetArgs>;

export const AUTOMATION_GET_TOOL = "automation-get";

export const automationGetTool = createToolDefinition(
  AUTOMATION_GET_TOOL,
  "Read one saved automation's details, including config and state; the source only when includeSource is true.",
  SAutomationGetArgs,
);
