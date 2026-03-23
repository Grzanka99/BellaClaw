import { z } from "zod";

export enum EMemoryImportance {
  Low = 0,
  Medium = 1,
  High = 2,
}

export enum EMemoryAuthor {
  User = "user",
  Bot = "bot",
}

export const SMemory = z.object({
  id: z.number(),
  userId: z.string(),
  author: z.enum(EMemoryAuthor),
  guild: z.string().or(z.null()),
  importance: z.enum(EMemoryImportance),
  message: z.string(),
  createdAt: z.coerce.date(),
  lastReadAt: z.coerce.date(),
});

export const SSaveArgs = SMemory.omit({ id: true, createdAt: true, lastReadAt: true });

export type TMemory = z.infer<typeof SMemory>;
export type TSaveArgs = z.infer<typeof SSaveArgs>;

export const SFindMemoryArgs = z.object({
  userId: z.string(),
  author: z.enum(EMemoryAuthor).optional(),
  guild: z.string().optional(),
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
