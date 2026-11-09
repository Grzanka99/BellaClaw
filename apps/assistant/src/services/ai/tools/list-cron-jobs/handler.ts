import { obj, type Static } from "@earendil-works/pi-schema";
import type { TCronJob } from "../../../../lib/cron-engine";
import { AutomationService } from "../../../automation";
import { CronSingleton } from "../../../cron";

export const SListCronJobsArgs = obj({}, { description: "No arguments are required" });

export type TListCronJobsArgs = Static<typeof SListCronJobsArgs>;

export type TListedCronJob = Omit<TCronJob, "automationIds"> & { automations: string[] };

export type TListCronJobsResult = TListedCronJob[];

/** Lists the chat's jobs with attached automations shown by name, in run order. */
export async function handleListCronJobs(chatId: string): Promise<TListCronJobsResult> {
  const jobs = await CronSingleton.instance.list(chatId);
  const automationIds = new Set(jobs.flatMap((job) => job.automationIds));
  const automations = await AutomationService.instance.getByIds(chatId, [...automationIds]);
  const namesById = new Map(automations.map((automation) => [automation.id, automation.name]));

  return jobs.map(({ automationIds: jobAutomationIds, ...job }) => {
    const names: string[] = [];
    for (const id of jobAutomationIds) {
      const name = namesById.get(id);
      if (name !== undefined) {
        names.push(name);
      }
    }

    return { ...job, automations: names };
  });
}
