import { OpenRouter } from "@openrouter/sdk";
import type { AssistantMessage, Message, ToolDefinitionJson } from "@openrouter/sdk/models";
import type { User } from "discord.js";
import { Config } from "../../../../config";
import type { TOption } from "../../../../types";
import { createLogger } from "../../../../utils/logger";
import type { TTools } from "../../tools";
import { DEFINE_MESSAGE_IMPORTANCE_TOOL } from "../../tools/define-message-importance/definition";
import { handleDefineMessageImportance } from "../../tools/define-message-importance/handler";
import { LIST_CRON_JOBS_TOOL } from "../../tools/list-cron-jobs/definition";
import { handleListCronJobs } from "../../tools/list-cron-jobs/handler";
import { SCHEDULE_RECURRING_TOOL } from "../../tools/schedule-recurring/definition";
import { handleScheduleRecurring } from "../../tools/schedule-recurring/handler";
import { SEARCH_MEMORY_TOOL } from "../../tools/search-memory/definition";
import { handleSearchMemory } from "../../tools/search-memory/handler";
import { UNSCHEDULE_RECURRING_TOOL } from "../../tools/unschedule-recurring/definition";
import { handleUnscheduleRecurring } from "../../tools/unschedule-recurring/handler";
import {
  EModelPurpose,
  ERole,
  type TChatWithTools,
  type THistoryItem,
  type TPrompt,
  type TToolCallResponse,
  type TToolCallResult,
  type TToolEntry,
} from "../../types";

export type TOpenrouterModel =
  (typeof Config.ai.providers.openrouter.models)[keyof typeof Config.ai.providers.openrouter.models];

const OPENROUTER_API_KEY = Bun.env.OPENROUTER_API_KEY as string;

const BASE_SYSTEM_INSTRUCTIONS_PATH = "./src/services/ai/instructions/base-system.xml";

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

type TChatWithToolsArgs = {
  prompt: TPrompt;
  history: THistoryItem[];
  user: TUserData;
  tools: TToolEntry[];
  purpose: EModelPurpose;
};

type TToolCallArgs = {
  prompt: TPrompt;
  instructions: THistoryItem[];
  tools: ToolDefinitionJson[];
  purpose: EModelPurpose;
  chatId?: string;
};

export class OpenrouterAiProvider {
  private static _instance: OpenrouterAiProvider;
  private logger = createLogger("OPENROUTER PROVIDER");
  private readonly openrouter: OpenRouter = new OpenRouter({ apiKey: OPENROUTER_API_KEY });

  private constructor() {
    this.logger.info("provider initialized");
  }

  public static get instance(): OpenrouterAiProvider {
    if (!OpenrouterAiProvider._instance) {
      OpenrouterAiProvider._instance = new OpenrouterAiProvider();
    }

    return OpenrouterAiProvider._instance;
  }

  public getModel(purpose: EModelPurpose): TOpenrouterModel {
    const { models } = Config.ai.providers.openrouter;

    switch (purpose) {
      case EModelPurpose.ToolCheap:
        return models.toolCheap;
      case EModelPurpose.General:
        return models.general;
      case EModelPurpose.ToolAccurate:
        return models.toolAccurate;
      case EModelPurpose.Chat:
        return models.chat;
      case EModelPurpose.ChatAccurate:
        return models.chatAccurate;
    }
  }

  public async chatWithTools(args: TChatWithToolsArgs): Promise<TOption<TChatWithTools>> {
    const model = this.getModel(args.purpose);

    this.logger.info(`Calling ${model}`);
    const baseSystemText = await Bun.file(BASE_SYSTEM_INSTRUCTIONS_PATH).text();
    const baseSystemMessage: THistoryItem = { role: ERole.System, content: baseSystemText };
    const messages: Message[] = [
      baseSystemMessage,
      buildUserContextMessage(args.user),
      ...args.history,
    ];

    for (const tool of args.tools) {
      if (tool.instructions) {
        messages.push({ role: ERole.System, content: tool.instructions });
      }
    }

    messages.push(args.prompt);

    const definitions = args.tools.map((t) => t.definition);

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

    const content = message.content;
    const responseText = typeof content === "string" ? content : "";

    return {
      response: responseText,
      toolCalls: message.toolCalls ?? [],
    };
  }

  public async toolCall<T = unknown>(args: TToolCallArgs): Promise<TOption<TToolCallResponse<T>>> {
    const model = this.getModel(args.purpose);

    this.logger.info(`Calling ${model}`);
    const messages: Message[] = [...args.instructions];
    messages.push(args.prompt);

    const res = await this.openrouter.chat.send({
      stream: false,
      model,
      messages,
      tools: args.tools,
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
        case LIST_CRON_JOBS_TOOL: {
          if (!args.chatId) {
            this.logger.error(`chatId is required for tool: ${LIST_CRON_JOBS_TOOL}`);
            continue;
          }
          const toolRes = await handleListCronJobs(toolCall, args.chatId);
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
          const toolRes = await handleScheduleRecurring(toolCall, args.chatId);
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
          const toolRes = await handleSearchMemory(toolCall, args.chatId);
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
          const toolRes = await handleUnscheduleRecurring(toolCall, args.chatId);
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

    const content = assistantMessage.content;
    const responseText = typeof content === "string" ? content : "";

    return {
      response: responseText,
      toolCalls: toolCalls,
      toolCallsResults,
    };
  }
}
