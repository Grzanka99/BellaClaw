import { z } from "zod";
import type { TCronJob } from "../../../cron/types";

export const SUnscheduleRecurringArgs = z.object({
  name: z.string(),
});

export type TUnscheduleRecurringArgs = z.infer<typeof SUnscheduleRecurringArgs>;

export type TUnscheduleRecurringResult = TCronJob;
