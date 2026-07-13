import z from "zod";
import type { TWebSearchResult } from "../../../../lib/web";

export const SWebSearchArgs = z
  .object({
    query: z.string().min(1).describe("Search query to submit to Tavily"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(10)
      .describe("Maximum number of results; defaults to 5")
      .optional(),
    topic: z
      .enum(["general", "news", "finance"])
      .describe("Search topic; defaults to general")
      .optional(),
    timeRange: z
      .enum(["day", "week", "month", "year"])
      .describe("Optional freshness range")
      .optional(),
  })
  .strict();

export type TWebSearchArgs = z.infer<typeof SWebSearchArgs>;

export type TWebSearch = {
  query: string;
  results: TWebSearchResult[];
};
