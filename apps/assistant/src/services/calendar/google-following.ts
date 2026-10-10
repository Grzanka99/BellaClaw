import type { TOption } from "@bellaclaw/shared";
import { applyPatch, eventBody, mapEvent } from "./google-events";
import type { GwsCalendarClient } from "./gws";
import { splitRecurrence } from "./recurrence";
import type { TCalendarEvent, TUpdateEventArguments } from "./types";

function assertFollowingSplitSafe(event: TCalendarEvent): void {
  const excluded = [...event.unsupportedManagedFields];
  if (event.eventLabelId !== undefined || event.eventLabelVersion !== undefined) {
    excluded.push("eventLabel");
  }
  if (event.endTimeUnspecified !== undefined) {
    excluded.push("endTimeUnspecified");
  }
  if (event.attendeesOmitted !== undefined) {
    excluded.push("attendeesOmitted");
  }
  if (event.gadget !== undefined) {
    excluded.push("gadget");
  }
  if (event.attendees.length > 0) {
    excluded.push("attendees");
  }
  if (event.conferenceData !== undefined || event.hangoutLink !== undefined) {
    excluded.push("conferenceData");
  }
  if (event.attachments.length > 0) {
    excluded.push("attachments");
  }
  if (excluded.length > 0) {
    throw new Error(`Following scope cannot safely split managed fields: ${excluded.join(", ")}`);
  }
}

export function isFirstOccurrence(master: TCalendarEvent, occurrence: TCalendarEvent): boolean {
  const masterStart = master.start.dateTime ?? master.start.date;
  const originalStart =
    occurrence.originalStartTime?.dateTime ?? occurrence.originalStartTime?.date;
  if (masterStart === undefined || originalStart === undefined) {
    return false;
  }
  return Date.parse(masterStart) === Date.parse(originalStart);
}

function successorId(calendarId: string, masterId: string, occurrence: TCalendarEvent): string {
  const originalStart =
    occurrence.originalStartTime?.dateTime ?? occurrence.originalStartTime?.date ?? "";
  const digest = new Bun.CryptoHasher("sha256")
    .update(`${calendarId}\0${masterId}\0${originalStart}`)
    .digest("hex");
  return `b${digest}`;
}

function isConfirmedNotFound(error: unknown): boolean {
  const detail = String(error).toLowerCase();
  return detail.includes("404") || detail.includes("not found");
}

export async function splitGoogleFollowingEvent(
  client: GwsCalendarClient,
  calendarId: string,
  master: TCalendarEvent,
  resolved: TCalendarEvent,
  args: TUpdateEventArguments,
  occurrenceNumber: TOption<number[]>,
): Promise<TCalendarEvent> {
  if (resolved.originalStartTime === undefined) {
    throw new Error("Following scope requires a concrete recurring occurrence");
  }
  assertFollowingSplitSafe(master);
  const split = splitRecurrence(
    master.recurrence,
    master.start,
    resolved.originalStartTime,
    occurrenceNumber,
  );
  const successor = eventBody(master);
  successor.start = resolved.start;
  successor.end = resolved.end;
  successor.recurrence = split.successor;
  const deterministicId = successorId(calendarId, master.id, resolved);
  successor.id = deterministicId;
  applyPatch(successor, args.patch, resolved);
  await client.patchEvent(calendarId, master.id, { recurrence: split.original }, args.signal);
  try {
    return mapEvent(calendarId, await client.insertEvent(calendarId, successor, args.signal));
  } catch (error) {
    try {
      const existing = mapEvent(
        calendarId,
        await client.getEvent(calendarId, deterministicId, AbortSignal.timeout(5_000)),
      );
      if (existing.id !== deterministicId) {
        throw new Error(
          `Google returned event ${existing.id} while verifying successor ${deterministicId}`,
        );
      }
      // Google keeps deleted events under their ID; that successor is not a completed split.
      if (existing.status !== "cancelled") {
        return existing;
      }
    } catch (verificationError) {
      if (!isConfirmedNotFound(verificationError)) {
        throw new Error(
          `Failed to create successor series and could not verify its state: ${String(error)}; verification: ${String(verificationError)}`,
        );
      }
    }
    try {
      await client.patchEvent(
        calendarId,
        master.id,
        { recurrence: master.recurrence },
        AbortSignal.timeout(5_000),
      );
    } catch (restoreError) {
      throw new Error(
        `Failed to create successor series and restore the original: ${String(error)}; restore: ${String(restoreError)}`,
      );
    }
    throw new Error(`Failed to create successor series; original restored: ${String(error)}`);
  }
}
