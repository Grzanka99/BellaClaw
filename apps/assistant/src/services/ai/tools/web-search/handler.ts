import { int, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import type { TWebSearchResult } from "../../../../lib/web";

export const SWebSearchArgs = obj({
  query: str({ minLength: 1, description: "Search query to submit to Tavily" }),
  maxResults: opt(
    int({
      minimum: 1,
      maximum: 10,
      description: "Maximum number of results; defaults to 5",
    }),
  ),
  topic: opt(oneOf(["general", "news", "finance"])),
  timeRange: opt(oneOf(["day", "week", "month", "year"])),
});

export type TWebSearchArgs = Static<typeof SWebSearchArgs>;

export type TWebSearch = {
  query: string;
  results: TWebSearchResult[];
};
