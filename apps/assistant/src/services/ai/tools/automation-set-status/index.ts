import { obj, oneOf, str } from "@earendil-works/pi-schema";
import { AutomationService, EAutomationStatus } from "../../../automation";
import { runAutomationOperation } from "../automation-errors";
import { summarizeAutomation } from "../automation-summary";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const automationSetStatus = defineTool({
  name: "automation-set-status",
  label: "Pause or resume automation",
  description: "Pause or resume a saved automation. Resuming resets its failure count.",
  schema: obj({
    name: str({ minLength: 1, description: "Exact name of the saved automation" }),
    status: oneOf(Object.values(EAutomationStatus), {
      description: "active resumes the automation and resets its failure count; paused stops it",
    }),
  }),
  instructions,
  mode: "sequential",
  privateErrors: true,
  logSafe: ["status", "failureCount", "outputCapBytes"],
  execute: async (context, args) => {
    const scope = requireChatId(context.chatId);
    const automation = await runAutomationOperation(() =>
      AutomationService.instance.setStatus(scope, args.name, args.status),
    );

    return summarizeAutomation(automation);
  },
});
