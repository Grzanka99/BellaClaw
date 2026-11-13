import { obj, str } from "@earendil-works/pi-schema";
import { fromCronJobRecord } from "../../../cron/types";
import { EEventType } from "../../../events/catalog";
import { runCronJobOperation } from "../cron-content";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

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
    const scope = requireChatId(context.chatId);

    return runCronJobOperation(async () => {
      const cancelled = await context.events.request(
        EEventType.CronJobCancelRequested,
        { name: args.name, scope },
        { outcome: EEventType.CronJobCancelled, step: undefined, key: scope, timeoutMs: undefined },
      );

      return fromCronJobRecord(cancelled.payload.job);
    });
  },
});
