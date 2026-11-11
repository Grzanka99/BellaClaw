import { obj } from "@earendil-works/pi-schema";
import { AutomationService } from "../../../automation";
import { CronScheduler } from "../../../cron";
import { toCronJobResult } from "../cron-content";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const listCronJobs = defineTool({
  name: "list-cron-jobs",
  label: "List cron jobs",
  description:
    "List all currently scheduled cron jobs. Use this to check what reminders or recurring tasks exist, so you can inform the user or decide whether to unschedule any.",
  schema: obj({}, { description: "No arguments are required" }),
  instructions,
  mode: "parallel",
  logSafe: [],
  privateErrors: true,
  execute: async (context) => {
    const chatId = requireChatId(context.chatId);
    const jobs = await CronScheduler.instance.list(chatId);
    const automationIds = new Set(jobs.flatMap((job) => job.automationIds));
    const automations = await AutomationService.instance.getByIds(chatId, [...automationIds]);
    const namesById = new Map(automations.map((automation) => [automation.id, automation.name]));

    // Attached automations are shown by name, in run order.
    return jobs.map((job) => {
      const names: string[] = [];
      for (const id of job.automationIds) {
        const name = namesById.get(id);
        if (name !== undefined) {
          names.push(name);
        }
      }

      return { ...toCronJobResult(job), automations: names };
    });
  },
});
