import { type Static, Type } from "@earendil-works/pi-ai";
import { validateListCalendarEventsArgs } from "../list-calendar-events/handler";

export const SFindCalendarAvailabilityArgs = Type.Object(
  {
    timeMin: Type.String({
      format: "date-time",
      description: "Inclusive search-window start as RFC 3339 with an explicit timezone",
    }),
    timeMax: Type.String({
      format: "date-time",
      description: "Exclusive search-window end as RFC 3339 with an explicit timezone",
    }),
    durationMinutes: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Requested free-slot duration; omit when only checking conflicts",
      }),
    ),
  },
  { additionalProperties: false },
);

export type TFindCalendarAvailabilityArgs = Static<typeof SFindCalendarAvailabilityArgs>;

export function validateFindCalendarAvailabilityArgs(
  args: TFindCalendarAvailabilityArgs,
): TFindCalendarAvailabilityArgs {
  validateListCalendarEventsArgs(args);
  return args;
}
