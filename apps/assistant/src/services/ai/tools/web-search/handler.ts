import { type Static, Type } from "@earendil-works/pi-ai";
import type { TWebSearchResult } from "../../../../lib/web";

export const SWebSearchArgs = Type.Object(
  {
    query: Type.String({ minLength: 1, description: "Search query to submit to Tavily" }),
    maxResults: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10,
        description: "Maximum number of results; defaults to 5",
      }),
    ),
    topic: Type.Optional(
      Type.Union([Type.Literal("general"), Type.Literal("news"), Type.Literal("finance")]),
    ),
    timeRange: Type.Optional(
      Type.Union([
        Type.Literal("day"),
        Type.Literal("week"),
        Type.Literal("month"),
        Type.Literal("year"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export type TWebSearchArgs = Static<typeof SWebSearchArgs>;

export type TWebSearch = {
  query: string;
  results: TWebSearchResult[];
};
