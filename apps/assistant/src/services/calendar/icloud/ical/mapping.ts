import type { TOption } from "@bellaclaw/shared";
import type ICAL from "ical.js";
import {
  ECalendarProvider,
  type TCalendarEvent,
  type TCalendarPerson,
  type TEventDateTime,
} from "../../types";
import { eventTime, occurrenceKey, recurrence, text } from "./time";

function person(property: ICAL.Property): TCalendarPerson {
  const value = property.getFirstValue();
  let email: TOption<string>;
  if (typeof value === "string") {
    email = value;
    if (value.toLowerCase().startsWith("mailto:")) {
      email = value.slice(7);
    }
  }
  const displayName = property.getParameter("cn");
  const responseStatus = property.getParameter("partstat");
  return {
    id: undefined,
    email,
    displayName: undefined,
    responseStatus: undefined,
    self: undefined,
    optional: undefined,
    resource: undefined,
    comment: undefined,
    additionalGuests: undefined,
    ...(typeof displayName === "string" && { displayName }),
    ...(typeof responseStatus === "string" && { responseStatus }),
  };
}

export function mapICalendarEvent(
  filename: string,
  calendarId: string,
  event: ICAL.Event,
  start: ICAL.Time,
  end: ICAL.Time,
  timezone: string,
  original?: ICAL.Time,
  etag?: string,
): TCalendarEvent {
  let id = filename;
  let recurringEventId: TOption<string>;
  let originalStartTime: TOption<TEventDateTime>;
  if (original !== undefined) {
    id += `#${occurrenceKey(original)}`;
    recurringEventId = filename;
    originalStartTime = eventTime(original, timezone);
  }
  const organizerProperty = event.component.getFirstProperty("organizer");
  let organizer: TOption<TCalendarPerson>;
  if (organizerProperty !== null) {
    organizer = person(organizerProperty);
  }
  const status = text(event.component, "status")?.toLowerCase();
  return {
    provider: ECalendarProvider.ICloud,
    calendarId,
    id,
    etag,
    status,
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: eventTime(start, timezone),
    end: eventTime(end, timezone),
    transparency: text(event.component, "transp")?.toLowerCase(),
    recurrence: recurrence(event),
    recurringEventId,
    originalStartTime,
    organizer,
    attendees: event.component.getAllProperties("attendee").map(person),
    attachments: event.component
      .getAllProperties("attach")
      .map((property) => property.toICALString()),
    sequence: Number(event.component.getFirstPropertyValue("sequence") ?? 0),
    colorId: undefined,
    eventLabelId: undefined,
    eventLabelVersion: undefined,
    endTimeUnspecified: undefined,
    attendeesOmitted: undefined,
    gadget: undefined,
    eventType: undefined,
    creator: undefined,
    hangoutLink: undefined,
    conferenceData: undefined,
    htmlLink: text(event.component, "url"),
    visibility: text(event.component, "class")?.toLowerCase(),
    created: undefined,
    updated: undefined,
    iCalUID: event.uid,
    reminders: event.component.getAllSubcomponents("valarm").map((alarm) => alarm.toString()),
    googleDetails: undefined,
    unsupportedManagedFields: [],
  };
}
