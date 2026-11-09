import { obj, oneOf, type Static, str } from "@earendil-works/pi-schema";
import { EAutomationStatus } from "../../../automation";
import { createToolDefinition } from "../definition";

export const SAutomationSetStatusArgs = obj({
  name: str({ minLength: 1, description: "Exact name of the saved automation" }),
  status: oneOf(Object.values(EAutomationStatus), {
    description: "active resumes the automation and resets its failure count; paused stops it",
  }),
});

export type TAutomationSetStatusArgs = Static<typeof SAutomationSetStatusArgs>;

export const AUTOMATION_SET_STATUS_TOOL = "automation-set-status";

export const automationSetStatusTool = createToolDefinition(
  AUTOMATION_SET_STATUS_TOOL,
  "Pause or resume a saved automation. Resuming resets its failure count.",
  SAutomationSetStatusArgs,
);
