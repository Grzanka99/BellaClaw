import { type Static, Type } from "@earendil-works/pi-ai";
import type { TCronJob } from "../../../../lib/cron-engine";

export const SListCronJobsArgs = Type.Object(
  {},
  {
    additionalProperties: false,
    description: "No arguments are required",
  },
);

export type TListCronJobsArgs = Static<typeof SListCronJobsArgs>;

export type TListCronJobsResult = TCronJob[];
