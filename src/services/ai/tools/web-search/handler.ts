import z from "zod";
import type { TSearchWebArgs, TWebSearchResult } from "../../../../lib/web";

export const SWebSearchArgs = z
  .object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(10).optional(),
    topic: z.enum(["general", "news", "finance"]).optional(),
    timeRange: z.enum(["day", "week", "month", "year"]).optional(),
  })
  .strict();

export type TWebSearchArgs = TSearchWebArgs;

export type TWebSearch = {
  query: string;
  results: TWebSearchResult[];
};
