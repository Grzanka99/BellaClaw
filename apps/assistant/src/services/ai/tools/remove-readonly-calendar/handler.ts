import { obj, type Static, str } from "@earendil-works/pi-schema";

export const SRemoveReadonlyCalendarArgs = obj({
  calendarId: str({
    minLength: 1,
    description: "Configured read-only Google calendar ID to remove",
  }),
});

export type TRemoveReadonlyCalendarArgs = Static<typeof SRemoveReadonlyCalendarArgs>;
