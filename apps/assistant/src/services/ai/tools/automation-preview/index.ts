import { arr, int, map, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { AutomationService, MAX_AUTOMATION_OUTPUT_CAP_BYTES } from "../../../automation";
import { EAutomationRunOutcome, previewAutomationDraft } from "../../../automation/runner";
import { EConfigKey } from "../../../settings/schema";
import { runAutomationOperation } from "../automation-errors";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

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

export const automationPreview = defineTool({
  name: "automation-preview",
  label: "Preview automation",
  description:
    "Run a new or changed automation script once against real data without saving it. Returns a previewId only when the run succeeds.",
  schema: SAutomationPreviewArgs,
  instructions,
  mode: "sequential",
  logSafe: ["success", "outputCapBytes"],
  privateErrors: true,
  execute: async (context, args, signal) => {
    const scope = requireChatId(context.chatId);
    const draft = await runAutomationOperation(() =>
      AutomationService.instance.createDraft({
        scope,
        name: args.name,
        instructions: args.instructions,
        source: args.source,
        config: args.config,
        allowedOrigins: args.allowedOrigins,
        outputCapBytes: args.outputCapBytes,
      }),
    );
    const report = await previewAutomationDraft(draft, {
      timezone: context.settings[EConfigKey.AiInstructionsTimezone],
      trace: context.trace,
      signal,
    });

    if (report.outcome === EAutomationRunOutcome.Failed) {
      // Only a successful preview may leave a draft that automation-save can make live.
      await AutomationService.instance.deleteDraft(scope, draft.id);

      return {
        success: false,
        error: report.error,
        fetched: report.fetches,
        logs: report.logs,
      };
    }

    return {
      success: true,
      previewId: draft.id,
      name: draft.name,
      input: {
        allowedOrigins: draft.allowedOrigins,
        config: draft.config,
        outputCapBytes: draft.outputCapBytes,
        fetched: report.fetches.map((fetch) => ({
          url: fetch.url,
          status: fetch.status,
          bytes: fetch.bytes,
        })),
      },
      output: { outcome: report.outcome, text: report.text, data: report.data },
      logs: report.logs,
    };
  },
});
