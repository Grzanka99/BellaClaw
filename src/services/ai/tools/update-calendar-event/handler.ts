import { type Static, Type } from "@earendil-works/pi-ai";
import type { TUpdateEventPatch } from "../../../calendar/types";
import {
  SCreateCalendarEventArgs,
  validateCreateCalendarEventArgs,
} from "../create-calendar-event/handler";

const SScope = Type.Union([
  Type.Literal("occurrence"),
  Type.Literal("following"),
  Type.Literal("series"),
]);

export const SUpdateCalendarEventArgs = Type.Object(
  {
    eventId: Type.String({ minLength: 1, description: "Resolved writable-calendar event ID" }),
    scope: SScope,
    summary: Type.Optional(SCreateCalendarEventArgs.properties.summary),
    description: Type.Optional(SCreateCalendarEventArgs.properties.description),
    location: Type.Optional(SCreateCalendarEventArgs.properties.location),
    start: Type.Optional(SCreateCalendarEventArgs.properties.start),
    end: Type.Optional(SCreateCalendarEventArgs.properties.end),
    durationMinutes: Type.Optional(SCreateCalendarEventArgs.properties.durationMinutes),
    timezone: Type.Optional(SCreateCalendarEventArgs.properties.timezone),
    transparency: Type.Optional(SCreateCalendarEventArgs.properties.transparency),
    recurrence: Type.Optional(SCreateCalendarEventArgs.properties.recurrence),
  },
  { additionalProperties: false },
);

export type TUpdateCalendarEventArgs = Static<typeof SUpdateCalendarEventArgs>;

export function validateUpdateCalendarEventArgs(args: TUpdateCalendarEventArgs): TUpdateEventPatch {
  const {
    eventId: _eventId,
    scope: _scope,
    summary,
    description,
    location,
    start,
    end,
    durationMinutes,
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
    durationMinutes,
    timezone,
    transparency,
    recurrence,
  };

  if (Object.values(patch).every((value) => value === undefined)) {
    throw new Error("Provide at least one event field to update");
  }
  if (
    start === undefined &&
    (end !== undefined || durationMinutes !== undefined || timezone !== undefined)
  ) {
    throw new Error("Updating end, durationMinutes, or timezone requires start");
  }
  if (start !== undefined) {
    validateCreateCalendarEventArgs({
      summary: summary ?? "validation",
      start,
      end,
      durationMinutes,
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
