import { z } from "zod";
import type { TCronEngineJob } from "../../../../lib/cron-engine";

export const SScheduleRecurringArgs = z.object({
  name: z.string(),
  pattern: z.string(),
  data: z.string().optional(),
  overwrite: z.boolean().optional(),
});

export type TScheduleRecurringArgs = z.infer<typeof SScheduleRecurringArgs>;

export type TScheduleRecurringResult = TCronEngineJob;
