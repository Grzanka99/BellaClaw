import { createToolDefinition } from "../definition";
import { SSearchMemoryArgs } from "./handler";

export const SEARCH_MEMORY_TOOL = "search-memory" as const;

export const searchMemoryTool = createToolDefinition(
  SEARCH_MEMORY_TOOL,
  "Search through stored conversation memories by text, explicit-offset time range, result limit, or importance level.",
  SSearchMemoryArgs,
);
