import { type Static, Type } from "@earendil-works/pi-ai";
import { EAiProvider } from "../../types";

const SNonEmptyString = Type.String({ minLength: 1 });

export const SUpdateSettingsArgs = Type.Object(
  {
    timezone: Type.Optional(SNonEmptyString),
    language: Type.Optional(SNonEmptyString),
    assistantName: Type.Optional(SNonEmptyString),
    addressStyle: Type.Optional(SNonEmptyString),
    preferredReplyLength: Type.Optional(SNonEmptyString),
    aiProvider: Type.Optional(Type.Enum(EAiProvider)),
  },
  { additionalProperties: false, minProperties: 1 },
);

export type TUpdateSettingsArgs = Static<typeof SUpdateSettingsArgs>;
