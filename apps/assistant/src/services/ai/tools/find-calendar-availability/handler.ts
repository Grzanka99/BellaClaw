import { int, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { validateListCalendarEventsArgs } from "../list-calendar-events/handler";

export const SFindCalendarAvailabilityArgs = obj({
  timeMin: str({
    format: "date-time",
    description: "Inclusive search-window start as RFC 3339 with an explicit timezone",
  }),
  timeMax: str({
    format: "date-time",
    description: "Exclusive search-window end as RFC 3339 with an explicit timezone",
  }),
  durationMinutes: opt(
    int({
      minimum: 1,
      description: "Requested free-slot duration; omit when only checking conflicts",
    }),
  ),
});

export type TFindCalendarAvailabilityArgs = Static<typeof SFindCalendarAvailabilityArgs>;

export function validateFindCalendarAvailabilityArgs(
  args: TFindCalendarAvailabilityArgs,
): TFindCalendarAvailabilityArgs {
  validateListCalendarEventsArgs(args);
  return args;
}
