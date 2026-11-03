import type { TOption } from "@bellaclaw/shared";

export type TCalendarAccess = "read" | "write";
export enum ECalendarProvider {
  Google = "google",
  ICloud = "icloud",
}

export type TProviderCalendar = {
  calendarId: string;
  summary: TOption<string>;
  readable: boolean;
  writable: boolean;
};

export type TCalendarProvider = {
  provider: ECalendarProvider;
  setup(): Promise<void>;
  discoverCalendars(signal?: AbortSignal): Promise<TProviderCalendar[]>;
  probeCalendar(calendarId: string, signal?: AbortSignal): Promise<TProviderCalendar>;
  listEvents(calendarId: string, args: TListEventsArguments): Promise<TCalendarEvent[]>;
  createEvent(calendarId: string, args: TCreateEventArguments): Promise<TCalendarEvent>;
  updateEvent(calendarId: string, args: TUpdateEventArguments): Promise<TCalendarEvent>;
  deleteEvent(calendarId: string, args: TDeleteEventArguments): Promise<void>;
};
export type TRecurrenceScope = "occurrence" | "following" | "series";

export type TCalendar = {
  provider: ECalendarProvider;
  calendarId: string;
  access: TCalendarAccess;
  addedAt: number;
  summary: TOption<string>;
  error: TOption<string>;
};

export type TEventDateTime = {
  date: TOption<string>;
  dateTime: TOption<string>;
  timeZone: TOption<string>;
};

export type TCalendarPerson = {
  id: TOption<string>;
  email: TOption<string>;
  displayName: TOption<string>;
  responseStatus: TOption<string>;
  self: TOption<boolean>;
  optional: TOption<boolean>;
  resource: TOption<boolean>;
  comment: TOption<string>;
  additionalGuests: TOption<number>;
};

export type TCalendarEvent = {
  provider: ECalendarProvider;
  calendarId: string;
  id: string;
  etag: TOption<string>;
  status: TOption<string>;
  colorId: TOption<string>;
  eventLabelId: TOption<string>;
  eventLabelVersion: TOption<string>;
  sequence: TOption<number>;
  endTimeUnspecified: TOption<boolean>;
  attendeesOmitted: TOption<boolean>;
  gadget: TOption<unknown>;
  eventType: TOption<string>;
  summary: TOption<string>;
  description: TOption<string>;
  location: TOption<string>;
  start: TEventDateTime;
  end: TEventDateTime;
  transparency: TOption<string>;
  recurrence: string[];
  recurringEventId: TOption<string>;
  originalStartTime: TOption<TEventDateTime>;
  organizer: TOption<TCalendarPerson>;
  creator: TOption<TCalendarPerson>;
  attendees: TCalendarPerson[];
  attachments: unknown[];
  hangoutLink: TOption<string>;
  conferenceData: TOption<unknown>;
  htmlLink: TOption<string>;
  visibility: TOption<string>;
  created: TOption<string>;
  updated: TOption<string>;
  iCalUID: TOption<string>;
  reminders: TOption<unknown>;
  googleDetails: TOption<unknown>;
  unsupportedManagedFields: string[];
};

export type TCalendarFailure = {
  provider: ECalendarProvider;
  calendarId: string;
  error: string;
};

export type TListEventsArguments = {
  userId: string;
  timeMin: string;
  timeMax: string;
  timezone?: string;
  query?: string;
  signal?: AbortSignal;
};

export type TListEventsResult = {
  events: TCalendarEvent[];
  failures: TCalendarFailure[];
};

export type TCreateEventArguments = {
  userId: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end?: string;
  durationMinutes?: number;
  timezone: string;
  transparency?: "opaque" | "transparent";
  recurrence?: string[];
  signal?: AbortSignal;
};

export type TUpdateEventPatch = {
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  durationMinutes?: number;
  timezone?: string;
  transparency?: "opaque" | "transparent";
  recurrence?: string[];
};

export type TUpdateEventArguments = {
  userId: string;
  eventId: string;
  scope: TRecurrenceScope;
  patch: TUpdateEventPatch;
  signal?: AbortSignal;
};

export type TDeleteEventArguments = {
  userId: string;
  eventId: string;
  scope: TRecurrenceScope;
  signal?: AbortSignal;
};

export type TBusyInterval = {
  start: string;
  end: string;
  events: TCalendarEvent[];
};

export type TAvailabilityArguments = {
  userId: string;
  timeMin: string;
  timeMax: string;
  durationMinutes?: number;
  timezone: string;
  signal?: AbortSignal;
};

export type TAvailabilityResult = {
  busy: TBusyInterval[];
  free: Array<{ start: string; end: string }>;
  failures: TCalendarFailure[];
};
