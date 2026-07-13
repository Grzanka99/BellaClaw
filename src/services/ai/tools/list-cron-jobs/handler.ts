import { z } from "zod";
import type { TCronJob } from "../../../../lib/cron-engine";

export const SListCronJobsArgs = z.object({}).describe("No arguments are required");

export type TListCronJobsArgs = z.infer<typeof SListCronJobsArgs>;

export type TListCronJobsResult = TCronJob[];
