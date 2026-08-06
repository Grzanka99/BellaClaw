import { type Static, Type } from "@earendil-works/pi-ai";

export const SGetSettingsArgs = Type.Object({}, { additionalProperties: false });

export type TGetSettingsArgs = Static<typeof SGetSettingsArgs>;
