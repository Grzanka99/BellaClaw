import type { DEFINE_MESSAGE_IMPORTANCE_TOOL } from "./define-message-importance/definition.ts";
import type { SEARCH_MEMORY_TOOL } from "./search-memory/definition.ts";

export type TTools = typeof DEFINE_MESSAGE_IMPORTANCE_TOOL | typeof SEARCH_MEMORY_TOOL;
