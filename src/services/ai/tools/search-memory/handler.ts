import z from "zod";
import { EMemoryImportance, type TMemory } from "../../../memory/types";

export const SSearchMemoryArgs = z.object({
  searchString: z
    .string()
    .describe("Partial text to search for anywhere within stored message content")
    .optional(),
  timeRange: z
    .object({
      start: z.iso
        .datetime({ offset: true })
        .describe("Inclusive start date-time with an explicit Z or numeric timezone offset")
        .transform((value) => new Date(value)),
      end: z.iso
        .datetime({ offset: true })
        .describe("Inclusive end date-time with an explicit Z or numeric timezone offset")
        .transform((value) => new Date(value)),
    })
    .describe("Filter memories created within this time range")
    .optional(),
  limit: z.number().int().positive().describe("Maximum number of memories to return").optional(),
  importance: z
    .array(z.enum(EMemoryImportance))
    .describe("Importance levels to include: low, medium, or high")
    .optional(),
});

export type TSearchMemoryArgs = z.infer<typeof SSearchMemoryArgs>;

export type TSearchMemory = {
  memories: TMemory[];
};
