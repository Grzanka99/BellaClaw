import { type Static, Type } from "@earendil-works/pi-ai";

export const SListCalendarEventsArgs = Type.Object(
  {
    timeMin: Type.String({
      format: "date-time",
      description: "Inclusive range start as RFC 3339 with an explicit timezone",
    }),
    timeMax: Type.String({
      format: "date-time",
      description: "Exclusive range end as RFC 3339 with an explicit timezone",
    }),
    query: Type.Optional(Type.String({ minLength: 1, description: "Optional event text query" })),
  },
  { additionalProperties: false },
);

export type TListCalendarEventsArgs = Static<typeof SListCalendarEventsArgs>;

export function validateListCalendarEventsArgs(
  args: TListCalendarEventsArgs,
): TListCalendarEventsArgs {
  const explicitTimezone = /T.*(?:Z|[+-]\d{2}:\d{2})$/;
  if (
    !explicitTimezone.test(args.timeMin) ||
    !explicitTimezone.test(args.timeMax) ||
    Number.isNaN(Date.parse(args.timeMin)) ||
    Number.isNaN(Date.parse(args.timeMax))
  ) {
    throw new Error("timeMin and timeMax must be RFC 3339 date-times with explicit timezones");
  }
  if (Date.parse(args.timeMax) <= Date.parse(args.timeMin)) {
    throw new Error("timeMax must be after timeMin");
  }

  return args;
}
