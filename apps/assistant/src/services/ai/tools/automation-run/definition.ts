import { obj, type Static, str } from "@earendil-works/pi-schema";
import { createToolDefinition } from "../definition";

export const SAutomationRunArgs = obj({
  name: str({ minLength: 1, description: "Exact name of the saved automation to run now" }),
});

export type TAutomationRunArgs = Static<typeof SAutomationRunArgs>;

export const AUTOMATION_RUN_TOOL = "automation-run";

export const automationRunTool = createToolDefinition(
  AUTOMATION_RUN_TOOL,
  "Run a saved automation now and return its output. Success stores its state; failure counts towards the automatic pause.",
  SAutomationRunArgs,
);
