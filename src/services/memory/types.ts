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
  author: z.nativeEnum(EMemoryAuthor),
  guild: z.string().or(z.null()),
  importance: z.nativeEnum(EMemoryImportance),
  message: z.string(),
  createdAt: z.coerce.date(),
  lastReadAt: z.coerce.date(),
});

export const SRemember = SMemory.omit({ id: true, createdAt: true, lastReadAt: true });

export type TMemory = z.infer<typeof SMemory>;
export type TRemember = z.infer<typeof SRemember>;

export type TFindMemoryArgs = {
  userId: string;
  query: string;
  timeRange?: {
    start: Date;
    end: Date;
  };
};
