import { EEventType } from "@bellaclaw/database";
import { obj, str } from "@earendil-works/pi-schema";
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
    const deleted = await runAutomationOperation(() =>
      context.events.request(
        EEventType.AutomationDeleteRequested,
        { scope, name: args.name },
        {
          outcome: EEventType.AutomationDeleted,
          step: undefined,
          key: scope,
          timeoutMs: undefined,
        },
      ),
    );
    // cron detaches the automation from its jobs in reaction to the deletion
    const detached = await context.events.waitFor(
      deleted.id,
      EEventType.CronAutomationDetached,
      undefined,
    );

    return {
      name: deleted.payload.name,
      updatedJobs: detached.payload.updatedJobs,
      cancelledJobs: detached.payload.cancelledJobs,
    };
  },
});
