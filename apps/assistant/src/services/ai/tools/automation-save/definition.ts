import { int, obj, type Static } from "@earendil-works/pi-schema";
import { createToolDefinition } from "../definition";

export const SAutomationSaveArgs = obj({
  previewId: int({
    minimum: 1,
    description: "previewId of the successful preview whose result the user confirmed",
  }),
});

export type TAutomationSaveArgs = Static<typeof SAutomationSaveArgs>;

export const AUTOMATION_SAVE_TOOL = "automation-save";

export const automationSaveTool = createToolDefinition(
  AUTOMATION_SAVE_TOOL,
  "Save a previewed automation exactly as it was previewed. Only after the user confirmed that preview's result.",
  SAutomationSaveArgs,
);
