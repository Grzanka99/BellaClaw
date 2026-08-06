import { type Static, Type } from "@earendil-works/pi-ai";

export const SAddReadonlyCalendarArgs = Type.Object(
  {
    calendarId: Type.String({
      minLength: 1,
      description: "Exact Google calendar ID explicitly supplied by the user",
    }),
  },
  { additionalProperties: false },
);

export type TAddReadonlyCalendarArgs = Static<typeof SAddReadonlyCalendarArgs>;
