import { obj, type Static, str } from "@earendil-works/pi-schema";
import type { TCronJob } from "../../../../lib/cron-engine";

export const SUnscheduleCronJobArgs = obj({
  name: str({
    description: "Unique name of the one-time or recurring cron job to cancel",
  }),
});

export type TUnscheduleCronJobArgs = Static<typeof SUnscheduleCronJobArgs>;

export type TUnscheduleCronJobResult = TCronJob;
