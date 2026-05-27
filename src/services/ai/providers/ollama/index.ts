import { Config } from "../../../../config";
import type { TOption } from "../../../../types";
import { createLogger } from "../../../../utils/logger";
import { readXmlAndInjectConfig } from "../../instructions/read-xml-and-inject-config";
import {
  EAssistantLoopConversationItemKind,
  type TRequestAssistantTurnArgs,
  type TRuntimeAssistantTurn,
} from "../../runtime";
import {
  isRecord,
  normalizeError,
  parseArgumentsForOllama,
  promptToText,
  serializeForModel,
} from "../../runtime/serialization";
import { EModelPurpose, ERole } from "../../types";
import {
  buildUserContextMessage,
  convertOllamaToolCalls,
  convertToolsForOllama,
  type TOllamaMessage,
} from "./converters";

export type TOllamaModel =
  (typeof Config.ai.providers.ollama.models)[keyof typeof Config.ai.providers.ollama.models];

const OLLAMA_BASE_URL = Bun.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

const BASE_SYSTEM_INSTRUCTIONS_PATH = "./src/services/ai/instructions/base-system.xml";

export type TOllamaRequestMessage = {
  role: string;
  content: string;
  thinking?: string;
  tool_calls?: NonNullable<TOllamaMessage["tool_calls"]>;
  tool_name?: string;
};

type TOllamaChatResponse = {
  model: string;
  message: TOllamaMessage;
  done: boolean;
};

function isOllamaToolCalls(value: unknown): value is NonNullable<TOllamaMessage["tool_calls"]> {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.every((toolCall) => {
    if (!isRecord(toolCall)) {
      return false;
    }

    if (!isRecord(toolCall.function)) {
      return false;
    }

    if (typeof toolCall.function.name !== "string") {
      return false;
    }

    return isRecord(toolCall.function.arguments);
  });
}

function isOllamaChatResponse(value: unknown): value is TOllamaChatResponse {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.model !== "string") {
    return false;
  }

  if (typeof value.done !== "boolean") {
    return false;
  }

  if (!isRecord(value.message)) {
    return false;
  }

  if (typeof value.message.role !== "string") {
    return false;
  }

  if (value.message.content !== undefined && typeof value.message.content !== "string") {
    return false;
  }

  if (value.message.thinking !== undefined && typeof value.message.thinking !== "string") {
    return false;
  }

  if (value.message.tool_calls !== undefined && !isOllamaToolCalls(value.message.tool_calls)) {
    return false;
  }

  return true;
}

export async function readBaseSystemText(): Promise<string> {
  return readXmlAndInjectConfig(BASE_SYSTEM_INSTRUCTIONS_PATH, Config);
}

export function buildOllamaSystemContent(
  args: TRequestAssistantTurnArgs,
  baseSystemText: string,
): string {
  const contentParts = [baseSystemText];

  if (args.user !== undefined) {
    contentParts.push(buildUserContextMessage(args.user));
  }

  for (const tool of args.tools) {
    if (tool.instructions === undefined) {
      continue;
    }

    contentParts.push(tool.instructions);
  }

  return contentParts.join("\n\n");
}

export function buildOllamaMessages(args: TRequestAssistantTurnArgs): TOllamaRequestMessage[] {
  const messages: TOllamaRequestMessage[] = [];

  for (const historyItem of args.history) {
    messages.push({
      role: historyItem.role,
      content: historyItem.content,
    });
  }

  for (const item of args.conversation) {
    switch (item.kind) {
      case EAssistantLoopConversationItemKind.UserPrompt: {
        messages.push({
          role: item.prompt.role,
          content: promptToText(item.prompt),
        });
        break;
      }
      case EAssistantLoopConversationItemKind.AssistantToolCalls: {
        const message: TOllamaRequestMessage = {
          role: ERole.Assistant,
          content: item.content,
          tool_calls: item.toolCalls.map((toolCall) => ({
            function: {
              name: toolCall.function.name,
              arguments: parseArgumentsForOllama(toolCall.function.arguments),
            },
          })),
        };

        if (item.reasoningContent !== undefined) {
          message.thinking = item.reasoningContent;
        }

        messages.push(message);
        break;
      }
      case EAssistantLoopConversationItemKind.ToolResult: {
        messages.push({
          role: "tool",
          content: serializeForModel(item.result),
          tool_name: item.result.toolName,
        });
        break;
      }
      case EAssistantLoopConversationItemKind.AssistantReply: {
        messages.push({
          role: ERole.Assistant,
          content: item.content,
        });
        break;
      }
    }
  }

  return messages;
}

async function ollamaChat(body: Record<string, unknown>): Promise<TOllamaChatResponse> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Ollama API error: ${res.status} ${res.statusText}`);
  }

  let responseJson: unknown;

  try {
    responseJson = await res.json();
  } catch (error) {
    throw new Error(`Failed to parse Ollama response: ${normalizeError(error)}`);
  }

  if (!isOllamaChatResponse(responseJson)) {
    throw new Error("Malformed Ollama chat response");
  }

  return responseJson;
}

export class OllamaAiProvider {
  private static _instance: OllamaAiProvider;
  private logger = createLogger("OLLAMA PROVIDER");

  private constructor() {
    this.logger.info("provider initialized");
  }

  public static get instance(): OllamaAiProvider {
    if (!OllamaAiProvider._instance) {
      OllamaAiProvider._instance = new OllamaAiProvider();
    }

    return OllamaAiProvider._instance;
  }

  public getModel(purpose: EModelPurpose): TOllamaModel {
    const { models } = Config.ai.providers.ollama;

    switch (purpose) {
      case EModelPurpose.ToolCheap:
        return models.toolCheap;
      case EModelPurpose.General:
        return models.general;
      case EModelPurpose.Chat:
        return models.chat;
      case EModelPurpose.ChatAccurate:
        return models.chatAccurate;
      case EModelPurpose.ToolAccurate:
        return models.toolAccurate;
    }
  }

  public async requestAssistantTurn(
    args: TRequestAssistantTurnArgs,
  ): Promise<TOption<TRuntimeAssistantTurn>> {
    const model = this.getModel(args.purpose);

    this.logger.info(`requestAssistantTurn: start, model=${model}`);
    const baseSystemText = await readBaseSystemText();
    const messages = buildOllamaMessages(args);

    const res = await ollamaChat({
      model,
      system: buildOllamaSystemContent(args, baseSystemText),
      messages,
      tools: convertToolsForOllama(args.tools.map((tool) => tool.definition)),
      stream: false,
    });

    const message = res.message;

    if (!message) {
      this.logger.warning("chatWithTools: no message in response");
      return undefined;
    }

    const responseText = message.content ?? "";
    const toolCalls = convertOllamaToolCalls(message.tool_calls ?? []);

    this.logger.info(
      `requestAssistantTurn: done, response length=${responseText.length}, toolCalls=${toolCalls.length}`,
    );
    return {
      response: responseText,
      toolCalls,
      reasoningContent: message.thinking,
    };
  }
}
