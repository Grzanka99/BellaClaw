import type { ToolDefinitionJson } from "@openrouter/sdk/models";
import type { User } from "discord.js";
import type { TOption } from "../../../types";
import { createLogger } from "../../../utils/logger";
import type { TTools } from "../tools";
import { DEFINE_MESSAGE_IMPORTANCE_TOOL } from "../tools/define-message-importance/definition";
import { handleDefineMessageImportance } from "../tools/define-message-importance/handler";
import { SEARCH_MEMORY_TOOL } from "../tools/search-memory/definition";
import { handleSearchMemory } from "../tools/search-memory/handler";
import {
  EModelPurpose,
  type TChatWithTools,
  type THistoryItem,
  type TPrompt,
  type TToolCallResponse,
  type TToolCallResult,
  type TToolEntry,
} from "../types";
import {
  MODEL_OLLAMA_GLM_5,
  MODEL_OLLAMA_MINIMAX_M2_7,
  MODEL_OLLAMA_NEMOTRON_3_SUPER,
} from "./models";

export type TOllamaModel =
  | typeof MODEL_OLLAMA_MINIMAX_M2_7
  | typeof MODEL_OLLAMA_GLM_5
  | typeof MODEL_OLLAMA_NEMOTRON_3_SUPER;

const OLLAMA_BASE_URL = (Bun.env.OLLAMA_BASE_URL as string) ?? "http://localhost:11434";

const BASE_SYSTEM_INSTRUCTIONS_PATH = "./src/services/ai-providers/instructions/base-system.xml";

export type TUserData = Pick<User, "username" | "id" | "displayName">;

type TOllamaMessage = {
  role: string;
  content: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
};

type TOllamaChatResponse = {
  model: string;
  message: TOllamaMessage;
  done: boolean;
};

function buildUserContextMessage(user: TUserData): string {
  return `Current user context - always use this user_id for tool calls:\n- user_id: ${user.id}\n- username: ${user.username}\n- displayName: ${user.displayName}`;
}

function flattenMessages(
  baseSystemText: string,
  user: TUserData,
  history: THistoryItem[],
  prompt: TPrompt,
  toolInstructions: string[] = [],
): { messages: Array<{ role: string; content: string }>; systemContent: string } {
  const userContext = buildUserContextMessage(user);
  const systemContent = [baseSystemText, userContext, ...toolInstructions].join("\n\n");

  const messages: Array<{ role: string; content: string }> = [];

  for (const item of history) {
    messages.push({ role: item.role, content: item.content });
  }

  const promptText = prompt.content.map((c) => c.text).join("\n");
  messages.push({ role: prompt.role, content: promptText });

  return { messages, systemContent };
}

function convertToolsForOllama(
  tools: ToolDefinitionJson[],
): Array<{ type: string; function: { name: string; description: string; parameters: unknown } }> {
  return tools.map((t) => ({
    type: t.type ?? "function",
    function: {
      name: t.function.name,
      description: t.function.description ?? "",
      parameters: t.function.parameters ?? { type: "object", properties: {} },
    },
  }));
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

  return res.json() as Promise<TOllamaChatResponse>;
}

export class OllamaAiProvider {
  private static _instance: OllamaAiProvider;
  private logger = createLogger("OLLAMA PROVIDER");

  private constructor() {}

  public static get instance(): OllamaAiProvider {
    if (!OllamaAiProvider._instance) {
      OllamaAiProvider._instance = new OllamaAiProvider();
    }

    return OllamaAiProvider._instance;
  }

  public getModel(purpose: EModelPurpose): TOllamaModel {
    switch (purpose) {
      case EModelPurpose.ToolCheap:
        return MODEL_OLLAMA_NEMOTRON_3_SUPER;
      case EModelPurpose.General:
      case EModelPurpose.Chat:
        return MODEL_OLLAMA_MINIMAX_M2_7;
      case EModelPurpose.ToolAccurate:
      case EModelPurpose.ChatAccurate:
        return MODEL_OLLAMA_GLM_5;
    }
  }

  public async chat(
    prompt: TPrompt,
    history: THistoryItem[],
    user: TUserData,
    model: TOllamaModel,
  ): Promise<TOption<string>> {
    this.logger.info(`Calling ${model}`);
    const baseSystemText = await Bun.file(BASE_SYSTEM_INSTRUCTIONS_PATH).text();
    const { messages, systemContent } = flattenMessages(baseSystemText, user, history, prompt);

    const res = await ollamaChat({
      model,
      system: systemContent,
      messages,
      stream: false,
    });

    const data = res.message?.content;

    if (!data) {
      return undefined;
    }

    return data;
  }

  public async chatWithTools(
    prompt: TPrompt,
    history: THistoryItem[],
    user: TUserData,
    tools: TToolEntry[],
    model: TOllamaModel,
  ): Promise<TOption<TChatWithTools>> {
    this.logger.info(`Calling ${model}`);
    const baseSystemText = await Bun.file(BASE_SYSTEM_INSTRUCTIONS_PATH).text();
    const toolInstructions = tools
      .filter((t) => t.instructions)
      .map((t) => t.instructions as string);
    const { messages, systemContent } = flattenMessages(
      baseSystemText,
      user,
      history,
      prompt,
      toolInstructions,
    );

    const ollamaTools = convertToolsForOllama(tools.map((t) => t.definition));

    const res = await ollamaChat({
      model,
      system: systemContent,
      messages,
      tools: ollamaTools,
      stream: false,
    });

    const message = res.message;

    if (!message) {
      return undefined;
    }

    const responseText = message.content ?? "";

    const toolCalls = (message.tool_calls ?? []).map((tc, index) => ({
      id: `ollama-tool-${index}`,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: JSON.stringify(tc.function.arguments),
      },
    }));

    return {
      response: responseText,
      toolCalls,
    };
  }

  public async toolCall<T = unknown>(
    prompt: TPrompt,
    instructions: THistoryItem[],
    tools: ToolDefinitionJson[],
    model: TOllamaModel,
    chatId?: string,
  ): Promise<TOption<TToolCallResponse<T>>> {
    this.logger.info(`Calling ${model}`);
    const messages: Array<{ role: string; content: string }> = [];

    for (const item of instructions) {
      messages.push({ role: item.role, content: item.content });
    }

    const promptText = prompt.content.map((c) => c.text).join("\n");
    messages.push({ role: prompt.role, content: promptText });

    const ollamaTools = convertToolsForOllama(tools);

    const res = await ollamaChat({
      model,
      messages,
      tools: ollamaTools,
      stream: false,
    });

    const message = res.message;

    if (!message) {
      return undefined;
    }

    const ollamaToolCalls = message.tool_calls ?? [];

    const toolCalls = ollamaToolCalls.map((tc, index) => ({
      id: `ollama-tool-${index}`,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: JSON.stringify(tc.function.arguments),
      },
    }));

    const toolCallsResults: TToolCallResult<T>[] = [];

    for (const tc of ollamaToolCalls) {
      const toolCallForHandler = {
        id: `ollama-tool-handler`,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments),
        },
      };

      switch (tc.function.name as TTools) {
        case DEFINE_MESSAGE_IMPORTANCE_TOOL: {
          const toolRes = handleDefineMessageImportance(toolCallForHandler);
          if (!toolRes) {
            this.logger.error(`Invalid arguments for tool: ${DEFINE_MESSAGE_IMPORTANCE_TOOL}`);
            continue;
          }
          toolCallsResults.push({
            tool: DEFINE_MESSAGE_IMPORTANCE_TOOL,
            // NOTE: Thats the acceptable exception for type cast!
            data: toolRes as T,
          });
          break;
        }
        case SEARCH_MEMORY_TOOL: {
          if (!chatId) {
            this.logger.error(`chatId is required for tool: ${SEARCH_MEMORY_TOOL}`);
            continue;
          }
          const toolRes = await handleSearchMemory(toolCallForHandler, chatId);
          if (!toolRes) {
            this.logger.error(`Invalid arguments for tool: ${SEARCH_MEMORY_TOOL}`);
            continue;
          }
          toolCallsResults.push({
            tool: SEARCH_MEMORY_TOOL,
            // NOTE: Thats the acceptable exception for type cast!
            data: toolRes as T,
          });
          break;
        }
      }
    }

    const responseText = message.content ?? "";

    return {
      response: responseText,
      toolCalls,
      toolCallsResults,
    };
  }
}
