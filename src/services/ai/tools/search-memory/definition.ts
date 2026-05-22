import type { ToolDefinitionJson } from "@openrouter/sdk/models";

export const SEARCH_MEMORY_TOOL = "search-memory" as const;

export const searchMemoryTool: ToolDefinitionJson = {
  type: "function",
  function: {
    name: SEARCH_MEMORY_TOOL,
    description:
      "Search through stored conversation memories. Use this when you need to recall past messages, preferences, or information shared by the user. You can filter by text content, time range, limit results, and importance level.",
    parameters: {
      type: "object",
      properties: {
        searchString: {
          type: "string",
          description:
            "Partial text to search for in stored messages. Matches anywhere within the message content.",
        },
        timeRange: {
          type: "object",
          properties: {
            start: {
              type: "string",
              description: "Start date in ISO 8601 format (e.g. 2025-01-01T00:00:00Z)",
            },
            end: {
              type: "string",
              description: "End date in ISO 8601 format (e.g. 2025-12-31T23:59:59Z)",
            },
          },
          required: ["start", "end"],
          description: "Filter memories created within this time range.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of memories to return.",
        },
        importance: {
          type: "array",
          items: {
            type: "string",
            enum: ["low", "medium", "high"],
          },
          description:
            "Filter by importance level(s). Memories will be sorted by importance (high first), then by last read date.",
        },
      },
    },
  },
};
