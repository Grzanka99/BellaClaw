import { type Static, Type } from "@earendil-works/pi-ai";
import { createToolDefinition } from "../definition";

export const SSearchMemoryArgs = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      pattern: "\\S",
      description: "Natural-language query describing the conversation facts to find",
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
