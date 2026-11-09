import { obj, type Static } from "@earendil-works/pi-schema";
import type { TCronJob } from "../../../../lib/cron-engine";

export const SListCronJobsArgs = obj({}, { description: "No arguments are required" });

export type TListCronJobsArgs = Static<typeof SListCronJobsArgs>;

export type TListCronJobsResult = TCronJob[];
