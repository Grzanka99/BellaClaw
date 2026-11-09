import { obj, oneOf, type Static, str } from "@earendil-works/pi-schema";

export const SDeleteCalendarEventArgs = obj({
  eventId: str({ minLength: 1, description: "Resolved writable-calendar event ID" }),
  scope: oneOf(["occurrence", "following", "series"]),
});

export type TDeleteCalendarEventArgs = Static<typeof SDeleteCalendarEventArgs>;
