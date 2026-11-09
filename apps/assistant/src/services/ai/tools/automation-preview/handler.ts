import { AutomationService } from "../../../automation";
import {
  EAutomationRunOutcome,
  previewAutomationDraft,
  type TAutomationRunOptions,
} from "../../../automation/runner";
import type { TAutomationPreviewArgs } from "./definition";

export async function handleAutomationPreview(
  chatId: string,
  args: TAutomationPreviewArgs,
  options: TAutomationRunOptions,
) {
  const draft = await AutomationService.instance.createDraft({
    scope: chatId,
    name: args.name,
    instructions: args.instructions,
    source: args.source,
    config: args.config,
    allowedOrigins: args.allowedOrigins,
    outputCapBytes: args.outputCapBytes,
  });
  const report = await previewAutomationDraft(draft, options);

  if (report.outcome === EAutomationRunOutcome.Failed) {
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
}
