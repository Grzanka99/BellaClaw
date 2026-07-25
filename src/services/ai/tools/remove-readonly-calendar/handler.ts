import { type Static, Type } from "@earendil-works/pi-ai";

export const SRemoveReadonlyCalendarArgs = Type.Object(
  {
    calendarId: Type.String({
      minLength: 1,
      description: "Configured read-only Google calendar ID to remove",
    }),
  },
  { additionalProperties: false },
);

export type TRemoveReadonlyCalendarArgs = Static<typeof SRemoveReadonlyCalendarArgs>;
