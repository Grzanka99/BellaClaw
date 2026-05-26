import type { ToolDefinitionJson } from "@openrouter/sdk/models";

export const WEB_SEARCH_TOOL = "web-search";

export const webSearchTool: ToolDefinitionJson = {
  type: "function",
  function: {
    name: WEB_SEARCH_TOOL,
    description:
      "Search the public web for current information using DuckDuckGo HTML results. Use for recent facts, news, documentation, or sources not available in conversation context.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to submit to DuckDuckGo.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Maximum number of results to return. Defaults to 5.",
        },
      },
      required: ["query"],
    },
  },
};
