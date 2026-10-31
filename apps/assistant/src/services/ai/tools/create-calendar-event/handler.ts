import { type Static, Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { isCalendarDate, validateRecurrence } from "../../../calendar/event-fields";

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
        description: "iCalendar RRULE, RDATE, or EXDATE lines",
      }),
    ),
  },
  { additionalProperties: false },
);

export type TCreateCalendarEventArgs = Static<typeof SCreateCalendarEventArgs>;

const SDateTime = z.iso.datetime({ offset: true });

function allDayTimestamp(value: string, field: string): number {
  if (!isCalendarDate(value)) {
    throw new Error(`${field} must be a valid calendar date`);
  }
  return Date.parse(`${value}T00:00:00Z`);
}

export function validateCreateCalendarEventArgs(
  args: TCreateCalendarEventArgs,
): TCreateCalendarEventArgs {
  const startAllDay = args.start.length === 10;
  let startTimestamp: number;
  if (startAllDay) {
    startTimestamp = allDayTimestamp(args.start, "start");
  } else {
    startTimestamp = Date.parse(args.start);
    if (!SDateTime.safeParse(args.start).success || Number.isNaN(startTimestamp)) {
      throw new Error(
        "start must be YYYY-MM-DD or an RFC 3339 date-time with an explicit timezone",
      );
    }
  }
  if (args.end !== undefined) {
    const endAllDay = args.end.length === 10;

    if (startAllDay !== endAllDay) {
      throw new Error("start and end must both be all-day dates or timed date-times");
    }
    let endTimestamp: number;
    if (endAllDay) {
      endTimestamp = allDayTimestamp(args.end, "end");
    } else {
      endTimestamp = Date.parse(args.end);
      if (!SDateTime.safeParse(args.end).success || Number.isNaN(endTimestamp)) {
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
  if (args.recurrence !== undefined) {
    validateRecurrence(args.recurrence);
  }

  return args;
}
