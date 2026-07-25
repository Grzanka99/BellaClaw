import { type Static, Type } from "@earendil-works/pi-ai";

const STransparency = Type.Union([Type.Literal("opaque"), Type.Literal("transparent")]);

export const SCreateCalendarEventArgs = Type.Object(
  {
    summary: Type.String({ minLength: 1, description: "Event title" }),
    description: Type.Optional(Type.String({ description: "Event description" })),
    location: Type.Optional(Type.String({ description: "Event location" })),
    start: Type.String({
      minLength: 1,
      description: "YYYY-MM-DD for all-day, otherwise RFC 3339 with an explicit timezone",
    }),
    end: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Exclusive all-day date or timed RFC 3339 end",
      }),
    ),
    durationMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
    timezone: Type.Optional(
      Type.String({ minLength: 1, description: "IANA timezone; defaults to owner timezone" }),
    ),
    transparency: Type.Optional(STransparency),
    recurrence: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Google-native RRULE, RDATE, or EXDATE lines",
      }),
    ),
  },
  { additionalProperties: false },
);

export type TCreateCalendarEventArgs = Static<typeof SCreateCalendarEventArgs>;

const ALL_DAY = /^\d{4}-\d{2}-\d{2}$/;
const EXPLICIT_TIMEZONE = /T.*(?:Z|[+-]\d{2}:\d{2})$/;
const RECURRENCE = /^(RRULE|RDATE|EXDATE)(?:;[^:]*)?:/;

function allDayTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid calendar date`);
  }
  return timestamp;
}

export function validateCreateCalendarEventArgs(
  args: TCreateCalendarEventArgs,
): TCreateCalendarEventArgs {
  const startAllDay = ALL_DAY.test(args.start);
  let startTimestamp: number;
  if (startAllDay) {
    startTimestamp = allDayTimestamp(args.start, "start");
  } else {
    startTimestamp = Date.parse(args.start);
    if (!EXPLICIT_TIMEZONE.test(args.start) || Number.isNaN(startTimestamp)) {
      throw new Error(
        "start must be YYYY-MM-DD or an RFC 3339 date-time with an explicit timezone",
      );
    }
  }
  if (args.end !== undefined) {
    const endAllDay = ALL_DAY.test(args.end);

    if (startAllDay !== endAllDay) {
      throw new Error("start and end must both be all-day dates or timed date-times");
    }
    let endTimestamp: number;
    if (endAllDay) {
      endTimestamp = allDayTimestamp(args.end, "end");
    } else {
      endTimestamp = Date.parse(args.end);
      if (!EXPLICIT_TIMEZONE.test(args.end) || Number.isNaN(endTimestamp)) {
        throw new Error("end must be an RFC 3339 date-time with an explicit timezone");
      }
    }
    if (endTimestamp <= startTimestamp) {
      throw new Error("end must be after start");
    }
  }
  if (args.end !== undefined && args.durationMinutes !== undefined) {
    throw new Error("Provide end or durationMinutes, not both");
  }
  if (startAllDay && args.durationMinutes !== undefined) {
    throw new Error("All-day events do not accept durationMinutes");
  }
  if (args.recurrence?.some((line) => !RECURRENCE.test(line))) {
    throw new Error("Recurrence lines must start with RRULE:, RDATE:, or EXDATE:");
  }

  return args;
}
