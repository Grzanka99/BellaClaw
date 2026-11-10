import { obj, str } from "@earendil-works/pi-schema";
import { CronSingleton } from "../../cron";
import { defineTool, requireChatId, ToolError } from "./define-tool";
import instructions from "./unschedule-cron-job.xml" with { type: "text" };

export const unscheduleCronJob = defineTool({
  name: "unschedule-cron-job",
  label: "Delete cron job",
  description: "Cancel a previously scheduled one-time or recurring cron job by name.",
  schema: obj({
    name: str({
      description: "Unique name of the one-time or recurring cron job to cancel",
    }),
  }),
  instructions,
  mode: "sequential",
  logSafe: ["type", ["pattern", "cronPattern"], "nextRunAt", "timezone", "status"],
  privateErrors: true,
  execute: async (context, args) => {
    const result = await CronSingleton.instance.cancel(args.name, requireChatId(context.chatId));

    if ("error" in result) {
      throw new ToolError(
        `${result.operation}-failed`,
        `${result.operation} failed: ${String(result.error)}`,
      );
    }

    return result;
  },
});
