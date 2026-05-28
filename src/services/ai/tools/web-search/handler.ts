import z from "zod";
import type { TSearchWebArgs, TWebSearchResult } from "../../../../lib/web";

export const SWebSearchArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional(),
});

export type TWebSearchArgs = TSearchWebArgs;

export type TWebSearch = {
  query: string;
  results: TWebSearchResult[];
};
