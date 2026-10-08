import type { TOption } from "@bellaclaw/shared";
import { patchEvent } from "./event-fields";
import {
  ECalendarProvider,
  type TCalendarEvent,
  type TCalendarPerson,
  type TEventDateTime,
  type TUpdateEventPatch,
} from "./types";

function readString(value: unknown, key: string): TOption<string> {
  if (typeof value === "object" && value !== null) {
    const candidate = Reflect.get(value, key);
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

function readBoolean(value: unknown, key: string): TOption<boolean> {
  if (typeof value === "object" && value !== null && typeof Reflect.get(value, key) === "boolean") {
    return Reflect.get(value, key);
  }
  return undefined;
}

function readNumber(value: unknown, key: string): TOption<number> {
  if (typeof value === "object" && value !== null && typeof Reflect.get(value, key) === "number") {
    return Reflect.get(value, key);
  }
  return undefined;
}

function readObject(value: unknown, key: string): TOption<unknown> {
  if (typeof value === "object" && value !== null) {
    return Reflect.get(value, key);
  }
  return undefined;
}

function readStringArray(value: unknown, key: string): string[] {
  const candidate = readObject(value, key);
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate.filter((item) => typeof item === "string");
}

function readArray(value: unknown, key: string): unknown[] {
  const candidate = readObject(value, key);
  if (Array.isArray(candidate)) {
    return candidate;
  }
  return [];
}

function mapDateTime(value: unknown): TEventDateTime {
  return {
    date: readString(value, "date"),
    dateTime: readString(value, "dateTime"),
    timeZone: readString(value, "timeZone"),
  };
}

function mapPerson(value: unknown): TCalendarPerson {
  return {
    id: readString(value, "id"),
    email: readString(value, "email"),
    displayName: readString(value, "displayName"),
    responseStatus: readString(value, "responseStatus"),
    self: readBoolean(value, "self"),
    optional: readBoolean(value, "optional"),
    resource: readBoolean(value, "resource"),
    comment: readString(value, "comment"),
    additionalGuests: readNumber(value, "additionalGuests"),
  };
}

export function mapEvent(calendarId: string, value: unknown): TCalendarEvent {
  const id = readString(value, "id");
  if (id === undefined) {
    throw new Error(`Google returned an event without an id for calendar ${calendarId}`);
  }
  const attendeesValue = readObject(value, "attendees");
  const attendees: TCalendarPerson[] = [];
  if (Array.isArray(attendeesValue)) {
    for (const attendee of attendeesValue) {
      attendees.push(mapPerson(attendee));
    }
  }
  const organizerValue = readObject(value, "organizer");
  let organizer: TOption<TCalendarPerson>;
  if (organizerValue !== undefined) {
    organizer = mapPerson(organizerValue);
  }
  const creatorValue = readObject(value, "creator");
  let creator: TOption<TCalendarPerson>;
  if (creatorValue !== undefined) {
    creator = mapPerson(creatorValue);
  }
  let originalStartTime: TOption<TEventDateTime>;
  const originalStartValue = readObject(value, "originalStartTime");
  if (originalStartValue !== undefined) {
    originalStartTime = mapDateTime(originalStartValue);
  }
  return {
    provider: ECalendarProvider.Google,
    calendarId,
    id,
    etag: readString(value, "etag"),
    status: readString(value, "status"),
    colorId: readString(value, "colorId"),
    eventLabelId: readString(value, "eventLabelId"),
    eventLabelVersion: readString(value, "eventLabelVersion"),
    sequence: readNumber(value, "sequence"),
    endTimeUnspecified: readBoolean(value, "endTimeUnspecified"),
    attendeesOmitted: readBoolean(value, "attendeesOmitted"),
    gadget: readObject(value, "gadget"),
    eventType: readString(value, "eventType"),
    summary: readString(value, "summary"),
    description: readString(value, "description"),
    location: readString(value, "location"),
    start: mapDateTime(readObject(value, "start")),
    end: mapDateTime(readObject(value, "end")),
    transparency: readString(value, "transparency"),
    recurrence: readStringArray(value, "recurrence"),
    recurringEventId: readString(value, "recurringEventId"),
    originalStartTime,
    organizer,
    creator,
    attendees,
    attachments: readArray(value, "attachments"),
    hangoutLink: readString(value, "hangoutLink"),
    conferenceData: readObject(value, "conferenceData"),
    htmlLink: readString(value, "htmlLink"),
    visibility: readString(value, "visibility"),
    created: readString(value, "created"),
    updated: readString(value, "updated"),
    iCalUID: readString(value, "iCalUID"),
    reminders: readObject(value, "reminders"),
    googleDetails: value,
    unsupportedManagedFields: [
      "extendedProperties",
      "source",
      "anyoneCanAddSelf",
      "guestsCanInviteOthers",
      "guestsCanModify",
      "guestsCanSeeOtherGuests",
      "privateCopy",
      "locked",
      "workingLocationProperties",
      "outOfOfficeProperties",
      "focusTimeProperties",
      "birthdayProperties",
    ].filter((key) => readObject(value, key) !== undefined),
  };
}

export function assertMutableEvent(event: TCalendarEvent): void {
  if (event.status === "cancelled") {
    throw new Error(`Calendar event ${event.id} is cancelled`);
  }
  if (event.eventType !== undefined && event.eventType !== "default") {
    throw new Error(`Calendar event ${event.id} has unsupported type ${event.eventType}`);
  }
}

export function eventBody(event: TCalendarEvent): Record<string, unknown> {
  const body: Record<string, unknown> = {
    start: event.start,
    end: event.end,
    recurrence: event.recurrence,
  };
  if (event.summary !== undefined) {
    body.summary = event.summary;
  }
  if (event.description !== undefined) {
    body.description = event.description;
  }
  if (event.location !== undefined) {
    body.location = event.location;
  }
  if (event.transparency !== undefined) {
    body.transparency = event.transparency;
  }
  if (event.visibility !== undefined) {
    body.visibility = event.visibility;
  }
  if (event.status !== undefined) {
    body.status = event.status;
  }
  if (event.colorId !== undefined) {
    body.colorId = event.colorId;
  }
  if (event.sequence !== undefined) {
    body.sequence = event.sequence;
  }
  body.reminders = event.reminders ?? { useDefault: true };
  return body;
}

export function applyPatch(
  body: Record<string, unknown>,
  patch: TUpdateEventPatch,
  current: TCalendarEvent,
): void {
  const updated = patchEvent(current, patch);
  for (const field of ["summary", "description", "location", "transparency", "recurrence"]) {
    if (Reflect.get(patch, field) !== undefined) {
      body[field] = Reflect.get(updated, field);
    }
  }
  if (patch.start !== undefined) {
    body.start = updated.start;
    body.end = updated.end;
  }
}
