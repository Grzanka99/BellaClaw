import { obj, str } from "@earendil-works/pi-schema";
import { AutomationService } from "../../../automation";
import { EAutomationRunMode, runSavedAutomation } from "../../../automation/runner";
import { EConfigKey } from "../../../settings/schema";
import { runAutomationOperation } from "../automation-errors";
import { defineTool, requireChatId, ToolError } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const automationRun = defineTool({
  name: "automation-run",
  label: "Run automation",
  description:
    "Run a saved automation now and return its output. Success stores its state; failure counts towards the automatic pause.",
  schema: obj({
    name: str({ minLength: 1, description: "Exact name of the saved automation to run now" }),
  }),
  instructions,
  mode: "sequential",
  logSafe: ["outcome", "paused", "outputCapBytes"],
  privateErrors: true,
  execute: async (context, args, signal) => {
    const scope = requireChatId(context.chatId);
    const automation = await AutomationService.instance.get(scope, args.name);

    if (automation === undefined) {
      throw new ToolError("automation-not-found", `Automation '${args.name}' not found`);
    }

    const report = await runAutomationOperation(() =>
      runSavedAutomation(automation, EAutomationRunMode.Manual, {
        timezone: context.settings[EConfigKey.AiInstructionsTimezone],
        trace: context.trace,
        signal,
      }),
    );

    return {
      name: report.name,
      outcome: report.outcome,
      text: report.text,
      data: report.data,
      error: report.error,
      fetched: report.fetches,
      logs: report.logs,
      paused: report.paused,
    };
  },
});
