import { arr, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { ALL_DAY_DATE } from "../../../calendar/recurrence";
import { EEventType } from "../../../events/catalog";
import { EConfigKey } from "../../../settings/schema";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const SCalendarEventFields = {
  summary: str({ minLength: 1, description: "Event title" }),
  description: str({ description: "Event description" }),
  location: str({ description: "Event location" }),
  start: str({
    minLength: 1,
    description: "YYYY-MM-DD for all-day, otherwise RFC 3339 with an explicit timezone",
  }),
  end: str({
    minLength: 1,
    description:
      "Exclusive all-day date or timed RFC 3339 end with an explicit timezone. Omit for a one-hour timed event or a single-day all-day event",
  }),
  timezone: str({ minLength: 1, description: "IANA timezone; defaults to owner timezone" }),
  transparency: oneOf(["opaque", "transparent"]),
  recurrence: arr(str({ minLength: 1 }), {
    minItems: 1,
    description: "Google-native RRULE, RDATE, or EXDATE lines",
  }),
};

export const SCreateCalendarEventArgs = obj({
  summary: SCalendarEventFields.summary,
  description: opt(SCalendarEventFields.description),
  location: opt(SCalendarEventFields.location),
  start: SCalendarEventFields.start,
  end: opt(SCalendarEventFields.end),
  timezone: opt(SCalendarEventFields.timezone),
  transparency: opt(SCalendarEventFields.transparency),
  recurrence: opt(SCalendarEventFields.recurrence),
});

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
  args: Static<typeof SCreateCalendarEventArgs>,
): Static<typeof SCreateCalendarEventArgs> {
  const startAllDay = ALL_DAY_DATE.test(args.start);
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
    const endAllDay = ALL_DAY_DATE.test(args.end);

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
  if (args.recurrence?.some((line) => !RECURRENCE.test(line))) {
    throw new Error("Recurrence lines must start with RRULE:, RDATE:, or EXDATE:");
  }

  return args;
}

export const createCalendarEvent = defineTool({
  name: "create-calendar-event",
  label: "Create calendar event",
  description: "Create a timed, all-day, or recurring event on the trusted writable calendar.",
  schema: SCreateCalendarEventArgs,
  instructions,
  mode: "sequential",
  logSafe: [],
  execute: async (context, args) => {
    const chatId = requireChatId(context.chatId);
    const validatedArgs = validateCreateCalendarEventArgs(args);
    const created = await context.events.request(
      EEventType.CalendarEventCreateRequested,
      {
        ...validatedArgs,
        chatId,
        timezone: validatedArgs.timezone ?? context.settings[EConfigKey.AiInstructionsTimezone],
      },
      {
        outcome: EEventType.CalendarEventCreated,
        step: undefined,
        key: chatId,
        timeoutMs: undefined,
      },
    );
    return created.payload.event;
  },
});
