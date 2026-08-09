import { type Static, Type } from "@earendil-works/pi-ai";
import { createToolDefinition } from "../definition";

export const SSearchMemoryArgs = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      maxLength: 120,
      pattern: "\\S",
      description:
        "Short natural-language query naming ONE thing to recall, ideally under ten words. Long multi-topic queries match nothing; issue several searches instead.",
    }),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 25,
        description: "Maximum number of facts to return; defaults to 10",
      }),
    ),
  },
  { additionalProperties: false },
);

export type TSearchMemoryArgs = Static<typeof SSearchMemoryArgs>;

export const SEARCH_MEMORY_TOOL = "search-memory" as const;

export const searchMemoryTool = createToolDefinition(
  SEARCH_MEMORY_TOOL,
  "Search stored conversation facts using a natural-language query.",
  SSearchMemoryArgs,
);
