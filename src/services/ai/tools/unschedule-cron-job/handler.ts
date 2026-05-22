import { z } from "zod";
import type { TCronEngineJob } from "../../../../lib/cron-engine";

export const SUnscheduleCronJobArgs = z.object({
  name: z.string(),
});

export type TUnscheduleCronJobArgs = z.infer<typeof SUnscheduleCronJobArgs>;

export type TUnscheduleCronJobResult = TCronEngineJob;
