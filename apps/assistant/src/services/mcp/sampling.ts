import type { TOption } from "@bellaclaw/shared";
import type {
  AssistantMessage,
  Context,
  JsonValue,
  Message,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageResultWithTools,
  ContentBlock as McpContentBlock,
  SamplingMessageContentBlock,
  ToolUseContent,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { emptyUsage } from "../ai/llm";

export function createMcpSamplingRequest(
  params: CreateMessageRequest["params"],
  model: Model<string>,
): { context: Context; toolChoice: SimpleStreamOptions["toolChoice"] } {
  const tools = params.tools?.map((tool) => {
    return {
      name: tool.name,
      description: tool.description ?? `MCP sampling tool ${tool.name}`,
      parameters: tool.inputSchema,
    };
  });
  let toolChoice: SimpleStreamOptions["toolChoice"];
  if (params.toolChoice?.mode === "none") {
    toolChoice = "none";
  } else if (tools !== undefined && tools.length > 0) {
    toolChoice = "auto";
  }
  return {
    context: {
      systemPrompt: params.systemPrompt,
      messages: createMcpSamplingMessages(params, model),
      tools,
    },
    toolChoice,
  };
}

export function createMcpSamplingResult(
  result: AssistantMessage,
  fallbackModel: string,
): CreateMessageResult | CreateMessageResultWithTools {
  const toolUses: ToolUseContent[] = [];
  const textParts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "toolCall") {
      toolUses.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.arguments,
      });
    }
  }
  let stopReason: string = "endTurn";
  if (result.stopReason === "toolUse") {
    stopReason = "toolUse";
  } else if (result.stopReason === "length") {
    stopReason = "maxTokens";
  }
  const responseModel = result.responseModel ?? fallbackModel;
  if (toolUses.length > 0) {
    const response: CreateMessageResultWithTools = {
      role: "assistant",
      content: toolUses,
      model: responseModel,
      stopReason,
    };
    return response;
  }
  return {
    role: "assistant",
    content: { type: "text", text: textParts.join("\n") },
    model: responseModel,
    stopReason,
  };
}

function createMcpSamplingMessages(
  params: CreateMessageRequest["params"],
  model: Model<string>,
): Message[] {
  const messages: Message[] = [];
  const timestamp = Date.now();
  for (const message of params.messages) {
    let blocks: SamplingMessageContentBlock[];
    if (Array.isArray(message.content)) {
      blocks = message.content;
    } else {
      blocks = [message.content];
    }
    if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      for (const block of blocks) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          const input = z.record(z.string(), z.json()).safeParse(block.input);
          if (!input.success) {
            throw new Error("MCP sampling tool input must contain JSON values");
          }
          content.push({
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: input.data,
          });
        } else {
          content.push({ type: "text", text: describeMcpBlock(block) });
        }
      }
      let stopReason: AssistantMessage["stopReason"] = "stop";
      if (content.some((block) => block.type === "toolCall")) {
        stopReason = "toolUse";
      }
      messages.push({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason,
        timestamp,
      });
      continue;
    }
    const userContent: Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
    > = [];
    for (const block of blocks) {
      if (block.type === "tool_result") {
        if (userContent.length > 0) {
          messages.push({ role: "user", content: userContent.splice(0), timestamp });
        }
        const resultContent: Array<
          { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
        > = [];
        for (const item of block.content) {
          if (item.type === "text" || item.type === "image") {
            resultContent.push(item);
          } else {
            resultContent.push({ type: "text", text: describeMcpBlock(item) });
          }
        }
        let details: TOption<JsonValue>;
        if (block.structuredContent !== undefined) {
          const parsed = z.json().safeParse(block.structuredContent);
          if (!parsed.success) {
            throw new Error("MCP sampling structured content must contain JSON values");
          }
          details = parsed.data;
        }
        messages.push({
          role: "toolResult",
          toolCallId: block.toolUseId,
          toolName: "mcp-sampling-tool",
          content: resultContent,
          details,
          isError: block.isError ?? false,
          timestamp,
        });
      } else if (block.type === "text" || block.type === "image") {
        userContent.push(block);
      } else {
        userContent.push({ type: "text", text: describeMcpBlock(block) });
      }
    }
    if (userContent.length > 0) {
      messages.push({ role: "user", content: userContent, timestamp });
    }
  }
  return messages;
}

function describeMcpBlock(block: SamplingMessageContentBlock | McpContentBlock): string {
  if (block.type === "audio") {
    return `[Audio content: ${block.mimeType}]`;
  }
  if (block.type === "image") {
    return `[Image content: ${block.mimeType}]`;
  }
  if (block.type === "tool_result") {
    return JSON.stringify(block.structuredContent ?? block.content);
  }
  if (block.type === "tool_use") {
    return JSON.stringify({ tool: block.name, arguments: block.input });
  }
  if (block.type === "text") {
    return block.text;
  }
  return JSON.stringify(block);
}
