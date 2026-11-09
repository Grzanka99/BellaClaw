import { arr, int, map, obj, opt, type Static, str, unknown } from "@earendil-works/pi-schema";
import { MAX_AUTOMATION_OUTPUT_CAP_BYTES } from "../../../automation";
import { createToolDefinition } from "../definition";

export const SAutomationPreviewArgs = obj({
  name: str({
    minLength: 1,
    description: "Automation name, unique in this chat. Reuse the existing name to change it",
  }),
  source: str({
    minLength: 1,
    description: "ES module source: export default async function run(ctx, host) { ... }",
  }),
  config: map(unknown(), {
    description: "JSON object passed to the script as ctx.config (URLs, coordinates, thresholds)",
  }),
  allowedOrigins: arr(str({ format: "uri" }), {
    uniqueItems: true,
    description:
      "Minimal list of http(s) origins the script may fetch, e.g. https://api.open-meteo.com",
  }),
  instructions: opt(
    str({ minLength: 1, description: "Notes for whoever reads the output on how to interpret it" }),
  ),
  outputCapBytes: opt(
    int({
      minimum: 1,
      maximum: MAX_AUTOMATION_OUTPUT_CAP_BYTES,
      description: "Cap on the returned output size in bytes; defaults to 16384",
    }),
  ),
});

export type TAutomationPreviewArgs = Static<typeof SAutomationPreviewArgs>;

export const AUTOMATION_PREVIEW_TOOL = "automation-preview";

export const automationPreviewTool = createToolDefinition(
  AUTOMATION_PREVIEW_TOOL,
  "Run a new or changed automation script once against real data without saving it. Returns a previewId only when the run succeeds.",
  SAutomationPreviewArgs,
);
