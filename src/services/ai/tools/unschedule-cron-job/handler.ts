import { z } from "zod";
import type { TCronJob } from "../../../../lib/cron-engine";

export const SUnscheduleCronJobArgs = z.object({
  name: z.string(),
});

export type TUnscheduleCronJobArgs = z.infer<typeof SUnscheduleCronJobArgs>;

export type TUnscheduleCronJobResult = TCronJob;
