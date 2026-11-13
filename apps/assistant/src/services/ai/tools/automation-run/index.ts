import { obj, str } from "@earendil-works/pi-schema";
import { AutomationService } from "../../../automation";
import { AUTOMATION_RUN_TIMEOUT_MS, EAutomationRunMode } from "../../../automation/runner";
import { EEventType } from "../../../events/catalog";
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
  logSafe: ["outcome", "paused"],
  privateErrors: true,
  execute: async (context, args) => {
    const scope = requireChatId(context.chatId);
    const automation = await AutomationService.instance.get(scope, args.name);

    if (automation === undefined) {
      throw new ToolError("automation-not-found", `Automation '${args.name}' not found`);
    }

    const completed = await runAutomationOperation(() =>
      context.events.request(
        EEventType.AutomationRunRequested,
        {
          scope,
          automationId: automation.id,
          mode: EAutomationRunMode.Manual,
          timezone: context.settings[EConfigKey.AiInstructionsTimezone],
        },
        {
          outcome: EEventType.AutomationRunCompleted,
          step: undefined,
          key: scope,
          timeoutMs: AUTOMATION_RUN_TIMEOUT_MS,
        },
      ),
    );
    const report = completed.payload.report;

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
