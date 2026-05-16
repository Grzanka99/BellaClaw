import { z } from "zod";
import type { TCronEngineJob } from "../../../../lib/cron-engine";

export const SUnscheduleRecurringArgs = z.object({
  name: z.string(),
});

export type TUnscheduleRecurringArgs = z.infer<typeof SUnscheduleRecurringArgs>;

export type TUnscheduleRecurringResult = TCronEngineJob;
