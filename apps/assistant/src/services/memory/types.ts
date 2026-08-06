import { z } from "zod";
import { ERole } from "../ai/types";

export enum EMemoryImportance {
  Low = "low",
  Medium = "medium",
  High = "high",
}

export const SMemory = z.object({
  id: z.number(),
  chatId: z.string(),
  author: z.enum(ERole),
  importance: z.enum(EMemoryImportance),
  message: z.string(),
  createdAt: z.coerce.date(),
  lastReadAt: z.coerce.date(),
});

export const SSaveArgs = SMemory.omit({ id: true, createdAt: true, lastReadAt: true });

export type TMemory = z.infer<typeof SMemory>;
export type TSaveArgs = z.infer<typeof SSaveArgs>;

export const SFindMemoryArgs = z.object({
  chatId: z.string(),
  author: z.enum(ERole).optional(),
  importance: z.array(z.enum(EMemoryImportance)).optional(),
  searchString: z.string().optional(),
  timeRange: z
    .object({
      start: z.coerce.date(),
      end: z.coerce.date(),
    })
    .optional(),
  limit: z.number().int().positive().optional(),
});

export type TFindMemoryArgs = z.infer<typeof SFindMemoryArgs>;
