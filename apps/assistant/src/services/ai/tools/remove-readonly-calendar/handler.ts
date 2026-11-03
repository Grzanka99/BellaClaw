import { type Static, Type } from "@earendil-works/pi-ai";
import { ECalendarProvider } from "../../../calendar/types";

export const SRemoveReadonlyCalendarArgs = Type.Object(
  {
    provider: Type.Enum(ECalendarProvider),
    calendarId: Type.String({
      minLength: 1,
      description: "Configured read-only calendar ID to remove",
    }),
  },
  { additionalProperties: false },
);

export type TRemoveReadonlyCalendarArgs = Static<typeof SRemoveReadonlyCalendarArgs>;
