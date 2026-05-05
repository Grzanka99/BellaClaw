import type { ToolDefinitionJson } from "@openrouter/sdk/models";
import type { User } from "discord.js";
import type { TOption } from "../../../types";
import { createLogger } from "../../../utils/logger";
import type { TTools } from "../tools";
import { DEFINE_MESSAGE_IMPORTANCE_TOOL } from "../tools/define-message-importance/definition";
import { handleDefineMessageImportance } from "../tools/define-message-importance/handler";
import { LIST_CRON_JOBS_TOOL } from "../tools/list-cron-jobs/definition";
import { handleListCronJobs } from "../tools/list-cron-jobs/handler";
import { SCHEDULE_RECURRING_TOOL } from "../tools/schedule-recurring/definition";
import { handleScheduleRecurring } from "../tools/schedule-recurring/handler";
import { SEARCH_MEMORY_TOOL } from "../tools/search-memory/definition";
import { handleSearchMemory } from "../tools/search-memory/handler";
import { UNSCHEDULE_RECURRING_TOOL } from "../tools/unschedule-recurring/definition";
import { handleUnscheduleRecurring } from "../tools/unschedule-recurring/handler";
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
  buildMessages,
  convertOllamaToolCalls,
  convertToolsForOllama,
  flattenMessages,
  type TOllamaMessage,
} from "./converters";
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

type TChatWithToolsArgs = {
  prompt: TPrompt;
  history: THistoryItem[];
  user: TUserData;
  tools: TToolEntry[];
  model: TOllamaModel;
};

type TToolCallArgs = {
  prompt: TPrompt;
  instructions: THistoryItem[];
  tools: ToolDefinitionJson[];
  model: TOllamaModel;
  chatId?: string;
};

type TOllamaChatResponse = {
  model: string;
  message: TOllamaMessage;
  done: boolean;
};

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
    switch (purpose) {
      case EModelPurpose.ToolCheap:
        return MODEL_OLLAMA_NEMOTRON_3_SUPER;
      case EModelPurpose.General:
        return MODEL_OLLAMA_GLM_5;
      case EModelPurpose.Chat:
      case EModelPurpose.ChatAccurate:
        return MODEL_OLLAMA_MINIMAX_M2_7;
      case EModelPurpose.ToolAccurate:
        return MODEL_OLLAMA_MINIMAX_M2_7;
    }
  }

  public async chatWithTools(args: TChatWithToolsArgs): Promise<TOption<TChatWithTools>> {
    this.logger.info(`chatWithTools: start, model=${args.model}`);
    const baseSystemText = await Bun.file(BASE_SYSTEM_INSTRUCTIONS_PATH).text();
    const toolInstructions = args.tools
      .filter((t) => t.instructions)
      .map((t) => t.instructions as string);
    const { messages, systemContent } = flattenMessages(
      baseSystemText,
      args.user,
      args.history,
      args.prompt,
      toolInstructions,
    );

    const ollamaTools = convertToolsForOllama(args.tools.map((t) => t.definition));

    const res = await ollamaChat({
      model: args.model,
      system: systemContent,
      messages,
      tools: ollamaTools,
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
      `chatWithTools: done, response length=${responseText.length}, toolCalls=${toolCalls.length}`,
    );
    return {
      response: responseText,
      toolCalls,
    };
  }

  public async toolCall<T = unknown>(args: TToolCallArgs): Promise<TOption<TToolCallResponse<T>>> {
    this.logger.info(`toolCall: start, model=${args.model}`);
    const messages = buildMessages(args.instructions, args.prompt);

    const ollamaTools = convertToolsForOllama(args.tools);

    const res = await ollamaChat({
      model: args.model,
      messages,
      tools: ollamaTools,
      stream: false,
    });

    const message = res.message;

    if (!message) {
      this.logger.warning("toolCall: no message in response");
      return undefined;
    }

    const ollamaToolCalls = message.tool_calls ?? [];

    const toolCalls = convertOllamaToolCalls(ollamaToolCalls);

    const toolCallsResults: TToolCallResult<T>[] = [];

    for (const tc of ollamaToolCalls) {
      const handlerArgs = {
        id: `ollama-${tc.function.name}`,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments),
        },
      };

      switch (tc.function.name as TTools) {
        case DEFINE_MESSAGE_IMPORTANCE_TOOL: {
          const toolRes = handleDefineMessageImportance(handlerArgs);
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
        case LIST_CRON_JOBS_TOOL: {
          if (!args.chatId) {
            this.logger.error(`chatId is required for tool: ${LIST_CRON_JOBS_TOOL}`);
            continue;
          }
          const toolRes = await handleListCronJobs(handlerArgs, args.chatId);
          if (!toolRes) {
            this.logger.error(`Invalid arguments for tool: ${LIST_CRON_JOBS_TOOL}`);
            continue;
          }
          toolCallsResults.push({
            tool: LIST_CRON_JOBS_TOOL,
            // NOTE: Thats the acceptable exception for type cast!
            data: toolRes as T,
          });
          break;
        }
        case SCHEDULE_RECURRING_TOOL: {
          if (!args.chatId) {
            this.logger.error(`chatId is required for tool: ${SCHEDULE_RECURRING_TOOL}`);
            continue;
          }
          const toolRes = await handleScheduleRecurring(handlerArgs, args.chatId);
          if (!toolRes) {
            this.logger.error(`Invalid arguments for tool: ${SCHEDULE_RECURRING_TOOL}`);
            continue;
          }
          toolCallsResults.push({
            tool: SCHEDULE_RECURRING_TOOL,
            // NOTE: Thats the acceptable exception for type cast!
            data: toolRes as T,
          });
          break;
        }
        case SEARCH_MEMORY_TOOL: {
          if (!args.chatId) {
            this.logger.error(`chatId is required for tool: ${SEARCH_MEMORY_TOOL}`);
            continue;
          }
          const toolRes = await handleSearchMemory(handlerArgs, args.chatId);
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
        case UNSCHEDULE_RECURRING_TOOL: {
          if (!args.chatId) {
            this.logger.error(`chatId is required for tool: ${UNSCHEDULE_RECURRING_TOOL}`);
            continue;
          }
          const toolRes = await handleUnscheduleRecurring(handlerArgs, args.chatId);
          if (!toolRes) {
            this.logger.error(`Invalid arguments for tool: ${UNSCHEDULE_RECURRING_TOOL}`);
            continue;
          }
          toolCallsResults.push({
            tool: UNSCHEDULE_RECURRING_TOOL,
            // NOTE: Thats the acceptable exception for type cast!
            data: toolRes as T,
          });
          break;
        }
      }
    }

    const responseText = message.content ?? "";

    this.logger.info(`toolCall: done, ${toolCallsResults.length} tool results`);
    return {
      response: responseText,
      toolCalls,
      toolCallsResults,
    };
  }
}
