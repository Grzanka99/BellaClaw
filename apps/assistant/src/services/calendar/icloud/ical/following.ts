import type { TOption } from "@bellaclaw/shared";
import ICAL from "ical.js";
import { countRuleOccurrencesBefore, splitRecurrence } from "../../recurrence";
import type { TUpdateEventPatch } from "../../types";
import { ICalendarResource } from ".";
import { eventEnd, eventTime, replaceRecurrence, stamp } from "./time";

export function assertFollowingOrder(resource: ICalendarResource): void {
  for (const property of resource.master.component.getAllProperties("rdate")) {
    for (const value of property.getValues()) {
      if (value instanceof ICAL.Time && value.compare(resource.master.startDate) < 0) {
        throw new Error(
          "Following scope cannot safely split recurrence dates before the series start; edit an occurrence or the whole series",
        );
      }
    }
  }
}

export function splitICalendarResource(
  resource: ICalendarResource,
  calendarId: string,
  occurrence: string,
  patch?: TUpdateEventPatch,
): TOption<ICalendarResource> {
  assertFollowingOrder(resource);
  const original = resource.resolveOccurrence(occurrence);
  resource.event(calendarId, occurrence);
  const master = resource.event(calendarId);
  if (
    resource.master.component.hasProperty("organizer") ||
    master.attendees.length > 0 ||
    master.attachments.length > 0 ||
    resource.master.component.hasProperty("conference")
  ) {
    throw new Error(
      "Following scope cannot safely split invitations, attachments, or conferencing",
    );
  }
  for (const component of resource.calendar.getAllSubcomponents("vevent")) {
    if (component.hasProperty("recurrence-id")) {
      const exception = new ICAL.Event(component);
      if (exception.modifiesFuture()) {
        throw new Error("Following scope cannot split a series containing THISANDFUTURE overrides");
      }
      if (
        exception.recurrenceId.compare(original) >= 0 &&
        (patch?.start !== undefined || patch?.recurrence !== undefined)
      ) {
        throw new Error(
          "Changing following times or recurrence with modified future occurrences is not supported",
        );
      }
    }
  }
  const counts = master.recurrence
    .filter((line) => line.startsWith("RRULE:") && line.includes("COUNT="))
    .map((line) => countRuleOccurrencesBefore([line], master.start, eventTime(original)));
  const split = splitRecurrence(master.recurrence, master.start, eventTime(original), counts);
  let successor: TOption<ICalendarResource>;
  if (patch !== undefined) {
    const digest = new Bun.CryptoHasher("sha256")
      .update(`${calendarId}\0${master.iCalUID}\0${occurrence}`)
      .digest("hex");
    successor = new ICalendarResource(`b${digest}.ics`, resource.toString(), resource.timezone);
    successor.master.uid = `b${digest}@bellaclaw`;
    successor.master.startDate = original.clone();
    if (!successor.master.component.hasProperty("duration")) {
      successor.master.endDate = eventEnd(resource.master, original);
    }
    replaceRecurrence(successor.master, split.successor);
    for (const component of successor.calendar.getAllSubcomponents("vevent")) {
      if (component.hasProperty("recurrence-id")) {
        const exception = new ICAL.Event(component);
        if (exception.recurrenceId.compare(original) < 0) {
          successor.calendar.removeSubcomponent(component);
        } else {
          exception.uid = successor.master.uid;
        }
      }
    }
    successor.update(calendarId, "series", patch);
  }
  replaceRecurrence(resource.master, split.original);
  for (const component of resource.calendar.getAllSubcomponents("vevent")) {
    if (
      component.hasProperty("recurrence-id") &&
      new ICAL.Event(component).recurrenceId.compare(original) >= 0
    ) {
      resource.calendar.removeSubcomponent(component);
    }
  }
  stamp(resource.master);
  return successor;
}
