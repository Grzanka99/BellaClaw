import { obj, str } from "@earendil-works/pi-schema";
import { AutomationService } from "../../../automation";
import { runAutomationOperation } from "../automation-errors";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const automationDelete = defineTool({
  name: "automation-delete",
  label: "Delete automation",
  description:
    "Delete a saved automation and remove it from cron jobs. Returns the jobs that were updated or cancelled because of it.",
  schema: obj({
    name: str({ minLength: 1, description: "Exact name of the saved automation to delete" }),
  }),
  instructions,
  mode: "sequential",
  privateErrors: true,
  logSafe: [],
  execute: async (context, args) => {
    const scope = requireChatId(context.chatId);
    const result = await runAutomationOperation(() =>
      AutomationService.instance.delete(scope, args.name),
    );

    return {
      name: result.automation.name,
      updatedJobs: result.updatedJobs,
      cancelledJobs: result.cancelledJobs.map((job) => job.name),
    };
  },
});
