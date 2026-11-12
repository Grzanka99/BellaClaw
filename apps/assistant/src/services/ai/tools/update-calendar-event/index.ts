import { obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import type { TUpdateEventPatch } from "../../../calendar/types";
import { EEventType } from "../../../events/catalog";
import { SCalendarEventFields, validateCreateCalendarEventArgs } from "../create-calendar-event";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const SUpdateCalendarEventArgs = obj({
  eventId: str({ minLength: 1, description: "Resolved writable-calendar event ID" }),
  scope: oneOf(["occurrence", "following", "series"]),
  summary: opt(SCalendarEventFields.summary),
  description: opt(SCalendarEventFields.description),
  location: opt(SCalendarEventFields.location),
  start: opt(SCalendarEventFields.start),
  end: opt(SCalendarEventFields.end),
  timezone: opt(SCalendarEventFields.timezone),
  transparency: opt(SCalendarEventFields.transparency),
  recurrence: opt(SCalendarEventFields.recurrence),
});

export function validateUpdateCalendarEventArgs(
  args: Static<typeof SUpdateCalendarEventArgs>,
): TUpdateEventPatch {
  const {
    eventId: _eventId,
    scope: _scope,
    summary,
    description,
    location,
    start,
    end,
    timezone,
    transparency,
    recurrence,
  } = args;
  const patch = {
    summary,
    description,
    location,
    start,
    end,
    timezone,
    transparency,
    recurrence,
  };

  if (Object.values(patch).every((value) => value === undefined)) {
    throw new Error("Provide at least one event field to update");
  }
  if (start === undefined && (end !== undefined || timezone !== undefined)) {
    throw new Error("Updating end or timezone requires start");
  }
  if (start !== undefined) {
    validateCreateCalendarEventArgs({
      summary: summary ?? "validation",
      start,
      end,
      timezone,
      description,
      location,
      transparency,
      recurrence,
    });
  } else if (recurrence?.some((line) => !/^(RRULE|RDATE|EXDATE)(?:;[^:]*)?:/.test(line))) {
    throw new Error("Recurrence lines must start with RRULE:, RDATE:, or EXDATE:");
  }

  return patch;
}

export const updateCalendarEvent = defineTool({
  name: "update-calendar-event",
  label: "Update calendar event",
  description: "Patch one resolved event using an explicit occurrence, following, or series scope.",
  schema: SUpdateCalendarEventArgs,
  instructions,
  mode: "sequential",
  logSafe: [],
  execute: async (context, args) => {
    const chatId = requireChatId(context.chatId);
    const patch = validateUpdateCalendarEventArgs(args);

    const updated = await context.events.request(
      EEventType.CalendarEventUpdateRequested,
      { chatId, eventId: args.eventId, scope: args.scope, patch },
      {
        outcome: EEventType.CalendarEventUpdated,
        step: undefined,
        key: chatId,
        timeoutMs: undefined,
      },
    );
    return updated.payload.event;
  },
});
