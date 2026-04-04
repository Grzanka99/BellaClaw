import { OpenRouter } from "@openrouter/sdk";
import type { AssistantMessage, Message, ToolDefinitionJson } from "@openrouter/sdk/models";
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
  ERole,
  type TChatWithTools,
  type THistoryItem,
  type TPrompt,
  type TToolCallResponse,
  type TToolCallResult,
  type TToolEntry,
} from "../types";
import {
  MODEL_OPENROUTER_FREE,
  MODEL_OPENROUTER_GEMINI_3_1_PRO_PREVIEW,
  MODEL_OPENROUTER_GEMINI_3_FLASH_PREVIEW,
  MODEL_OPENROUTER_GPT_5_4_MINI,
} from "./models";

export type TOpenrouterModel =
  | typeof MODEL_OPENROUTER_FREE
  | typeof MODEL_OPENROUTER_GEMINI_3_FLASH_PREVIEW
  | typeof MODEL_OPENROUTER_GPT_5_4_MINI
  | typeof MODEL_OPENROUTER_GEMINI_3_1_PRO_PREVIEW;

const OPENROUTER_API_KEY = Bun.env.OPENROUTER_API_KEY as string;

const BASE_SYSTEM_INSTRUCTIONS_PATH = "./src/services/ai-providers/instructions/base-system.xml";

function buildUserContextMessage(user: TUserData): TPrompt {
  return {
    role: ERole.System,
    content: [
      {
        type: "text",
        text: `Current user context - always use this user_id for tool calls:\n- user_id: ${user.id}\n- username: ${user.username}\n- displayName: ${user.displayName}`,
      },
    ],
  };
}

export type TUserData = Pick<User, "username" | "id" | "displayName">;

export class OpenrouterAiProvider {
  private static _instance: OpenrouterAiProvider;
  private logger = createLogger("OPENROUTER PROVIDER");
  private readonly openrouter: OpenRouter = new OpenRouter({ apiKey: OPENROUTER_API_KEY });

  private constructor() {}

  public static get instance(): OpenrouterAiProvider {
    if (!OpenrouterAiProvider._instance) {
      OpenrouterAiProvider._instance = new OpenrouterAiProvider();
    }

    return OpenrouterAiProvider._instance;
  }

  public getModel(purpose: EModelPurpose): TOpenrouterModel {
    switch (purpose) {
      case EModelPurpose.ToolCheap:
      case EModelPurpose.General:
        return MODEL_OPENROUTER_FREE;
      case EModelPurpose.ToolAccurate:
        return MODEL_OPENROUTER_GEMINI_3_FLASH_PREVIEW;
      case EModelPurpose.Chat:
        return MODEL_OPENROUTER_GPT_5_4_MINI;
      case EModelPurpose.ChatAccurate:
        return MODEL_OPENROUTER_GEMINI_3_1_PRO_PREVIEW;
    }
  }

  public async chat(
    prompt: TPrompt,
    history: THistoryItem[],
    user: TUserData,
    model: TOpenrouterModel,
  ): Promise<TOption<string>> {
    this.logger.info(`Calling ${model}`);
    const baseSystemText = await Bun.file(BASE_SYSTEM_INSTRUCTIONS_PATH).text();
    const baseSystemMessage: THistoryItem = { role: ERole.System, content: baseSystemText };
    const messages: Message[] = [baseSystemMessage, buildUserContextMessage(user), ...history];
    messages.push(prompt);

    const res = await this.openrouter.chat.send({
      stream: false,
      model,
      messages,
    });

    console.log(res.choices);
    const data = res.choices[0]?.message.content;

    if (!data) {
      return undefined;
    }

    return data.toString();
  }

  public async chatWithTools(
    prompt: TPrompt,
    history: THistoryItem[],
    user: TUserData,
    tools: TToolEntry[],
    model: TOpenrouterModel,
  ): Promise<TOption<TChatWithTools>> {
    this.logger.info(`Calling ${model}`);
    const baseSystemText = await Bun.file(BASE_SYSTEM_INSTRUCTIONS_PATH).text();
    const baseSystemMessage: THistoryItem = { role: ERole.System, content: baseSystemText };
    const messages: Message[] = [baseSystemMessage, buildUserContextMessage(user), ...history];

    for (const tool of tools) {
      if (tool.instructions) {
        messages.push({ role: ERole.System, content: tool.instructions });
      }
    }

    messages.push(prompt);

    const definitions = tools.map((t) => t.definition);

    const res = await this.openrouter.chat.send({
      stream: false,
      model,
      messages,
      tools: definitions,
    });

    const message = res.choices[0]?.message;

    if (!message) {
      return undefined;
    }

    const assistantMessage = message as AssistantMessage;
    const content = assistantMessage.content;
    const responseText = typeof content === "string" ? content : "";

    return {
      response: responseText,
      toolCalls: assistantMessage.toolCalls ?? [],
    };
  }

  public async toolCall<T = unknown>(
    prompt: TPrompt,
    instructions: THistoryItem[],
    tools: ToolDefinitionJson[],
    model: TOpenrouterModel,
    chatId?: string,
  ): Promise<TOption<TToolCallResponse<T>>> {
    this.logger.info(`Calling ${model}`);
    const messages: Message[] = [...instructions];
    messages.push(prompt);

    const res = await this.openrouter.chat.send({
      stream: false,
      model,
      messages,
      tools,
    });

    const message = res.choices[0]?.message;

    if (!message) {
      return undefined;
    }

    const assistantMessage = message as AssistantMessage;
    const toolCalls = assistantMessage.toolCalls ?? [];
    const toolCallsResults: TToolCallResult<T>[] = [];

    for (const toolCall of toolCalls) {
      switch (toolCall.function?.name as TTools) {
        case DEFINE_MESSAGE_IMPORTANCE_TOOL: {
          const toolRes = handleDefineMessageImportance(toolCall);
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
          const toolRes = await handleSearchMemory(toolCall, chatId);
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

    const content = assistantMessage.content;
    const responseText = typeof content === "string" ? content : "";

    return {
      response: responseText,
      toolCalls: toolCalls,
      toolCallsResults,
    };
  }
}
