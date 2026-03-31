import type { ToolDefinitionJson } from "@openrouter/sdk/models";

export const defineMessageImportanceTool: ToolDefinitionJson = {
  type: "function",
  function: {
    name: "define-message-importance",
    description:
      "Analyzes a message and assigns an importance level (low, medium, high) based on its content and relevance",
    parameters: {
      type: "object",
      properties: {
        importance: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "The importance level of the message",
        },
        reasoning: {
          type: "string",
          description: "Brief explanation of why this importance level was chosen",
        },
      },
      required: ["importance", "reasoning"],
    },
  },
};
