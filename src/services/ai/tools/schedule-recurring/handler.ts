import { z } from "zod";
import type { TCronJob } from "../../../cron/types";

export const SScheduleRecurringArgs = z.object({
  name: z.string(),
  pattern: z.string(),
  group: z.string().optional(),
  overwrite: z.boolean().optional(),
});

export type TScheduleRecurringArgs = z.infer<typeof SScheduleRecurringArgs>;

export type TScheduleRecurringResult = TCronJob;
