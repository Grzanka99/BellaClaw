import { z } from "zod";
import type { TCronJob } from "../../../cron/types";

export const SListCronJobsArgs = z.object({});

export type TListCronJobsArgs = z.infer<typeof SListCronJobsArgs>;

export type TListCronJobsResult = TCronJob[];
