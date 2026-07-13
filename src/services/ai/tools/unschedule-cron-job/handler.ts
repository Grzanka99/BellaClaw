import { z } from "zod";
import type { TCronJob } from "../../../../lib/cron-engine";

export const SUnscheduleCronJobArgs = z.object({
  name: z.string().describe("Unique name of the one-time or recurring cron job to cancel"),
});

export type TUnscheduleCronJobArgs = z.infer<typeof SUnscheduleCronJobArgs>;

export type TUnscheduleCronJobResult = TCronJob;
