import { type Static, Type } from "@earendil-works/pi-ai";
import { EMemoryImportance } from "../../../memory/types";

export const SDefineMessageImportance = Type.Object(
  {
    reasoning: Type.String({
      description: "Brief explanation of why this importance level was chosen",
    }),
    importance: Type.Enum(EMemoryImportance, {
      description: "The importance level of the message: low, medium, or high",
    }),
  },
  { additionalProperties: false },
);

export type TDefineMessageImportance = Static<typeof SDefineMessageImportance>;
