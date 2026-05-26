import type { ToolDefinitionJson } from "@openrouter/sdk/models";

export const WEB_FETCH_TOOL = "web-fetch";

export const webFetchTool: ToolDefinitionJson = {
  type: "function",
  function: {
    name: WEB_FETCH_TOOL,
    description:
      "Fetch a public http or https URL and return its content as markdown, plain text, or raw HTML. Use after web-search when page content is needed.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Public http or https URL to fetch.",
        },
        format: {
          type: "string",
          enum: ["markdown", "text", "html"],
          description: "Output format. Defaults to markdown.",
        },
        timeout: {
          type: "integer",
          minimum: 1,
          maximum: 120,
          description: "Timeout in seconds. Defaults to 30 and cannot exceed 120.",
        },
      },
      required: ["url"],
    },
  },
};
