import z from "zod";
import { EMemoryImportance } from "../../../memory/types";

export const SDefineMessageImportance = z.object({
  reasoning: z.string().describe("Brief explanation of why this importance level was chosen"),
  importance: z
    .enum(EMemoryImportance)
    .describe("The importance level of the message: low, medium, or high"),
});

export type TDefineMessageImportance = z.infer<typeof SDefineMessageImportance>;
