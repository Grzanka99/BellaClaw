import { type Static, Type } from "@earendil-works/pi-ai";

export const SListCalendarsArgs = Type.Object({}, { additionalProperties: false });

export type TListCalendarsArgs = Static<typeof SListCalendarsArgs>;
