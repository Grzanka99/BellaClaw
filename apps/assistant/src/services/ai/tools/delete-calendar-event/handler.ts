import { type Static, Type } from "@earendil-works/pi-ai";

export const SDeleteCalendarEventArgs = Type.Object(
  {
    eventId: Type.String({ minLength: 1, description: "Resolved writable-calendar event ID" }),
    scope: Type.Union([
      Type.Literal("occurrence"),
      Type.Literal("following"),
      Type.Literal("series"),
    ]),
  },
  { additionalProperties: false },
);

export type TDeleteCalendarEventArgs = Static<typeof SDeleteCalendarEventArgs>;
