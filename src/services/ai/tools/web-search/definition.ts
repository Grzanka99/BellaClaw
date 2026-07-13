import { createToolDefinition } from "../definition";
import { SWebSearchArgs } from "./handler";

export const WEB_SEARCH_TOOL = "web-search";

export const webSearchTool = createToolDefinition(
  WEB_SEARCH_TOOL,
  "Search the public web with Tavily for current information. Use for recent facts, news, documentation, or sources not available in conversation context.",
  SWebSearchArgs,
);
