import { type Static, Type } from "@earendil-works/pi-ai";
import type { TCronJob } from "../../../../lib/cron-engine";

export const SUnscheduleCronJobArgs = Type.Object(
  {
    name: Type.String({
      description: "Unique name of the one-time or recurring cron job to cancel",
    }),
  },
  { additionalProperties: false },
);

export type TUnscheduleCronJobArgs = Static<typeof SUnscheduleCronJobArgs>;

export type TUnscheduleCronJobResult = TCronJob;
