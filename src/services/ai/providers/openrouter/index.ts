import { OpenRouter } from "@openrouter/sdk";
import type { Message } from "@openrouter/sdk/models";
import { Config } from "../../../../config";
import type { TOption } from "../../../../types";
import { createLogger } from "../../../../utils/logger";
import { readXmlAndInjectConfig } from "../../instructions/read-xml-and-inject-config";
import {
  EAssistantLoopConversationItemKind,
  type TRequestAssistantTurnArgs,
  type TRuntimeAssistantTurn,
  type TRuntimeUser,
} from "../../runtime";
import { extractTextContent, serializeForModel } from "../../runtime/serialization";
import { EModelPurpose, ERole } from "../../types";

export type TOpenrouterModel =
  (typeof Config.ai.providers.openrouter.models)[keyof typeof Config.ai.providers.openrouter.models];

const OPENROUTER_API_KEY = Bun.env.OPENROUTER_API_KEY ?? "";

const BASE_SYSTEM_INSTRUCTIONS_PATH = "./src/services/ai/instructions/base-system.xml";

function buildUserContextMessage(user: TRuntimeUser): Message {
  return {
    role: ERole.System,
    content: `Current user context - always use this user_id for tool calls:\n- user_id: ${user.id}\n- username: ${user.username}\n- displayName: ${user.displayName}`,
  };
}

export async function readBaseSystemText(): Promise<string> {
  return readXmlAndInjectConfig(BASE_SYSTEM_INSTRUCTIONS_PATH, Config);
}

export function buildOpenrouterMessages(
  args: TRequestAssistantTurnArgs,
  baseSystemText: string,
): Message[] {
  const messages: Message[] = [{ role: ERole.System, content: baseSystemText }];

  if (args.user !== undefined) {
    messages.push(buildUserContextMessage(args.user));
  }

  for (const historyItem of args.history) {
    messages.push({
      role: historyItem.role,
      content: historyItem.content,
    });
  }

  for (const tool of args.tools) {
    if (tool.instructions === undefined) {
      continue;
    }

    messages.push({ role: ERole.System, content: tool.instructions });
  }

  for (const item of args.conversation) {
    switch (item.kind) {
      case EAssistantLoopConversationItemKind.UserPrompt: {
        messages.push(item.prompt);
        break;
      }
      case EAssistantLoopConversationItemKind.AssistantToolCalls: {
        messages.push({
          role: ERole.Assistant,
          content: item.content,
          toolCalls: item.toolCalls,
        });
        break;
      }
      case EAssistantLoopConversationItemKind.ToolResult: {
        messages.push({
          role: "tool",
          content: serializeForModel(item.result),
          toolCallId: item.result.toolCallId,
        });
        break;
      }
      case EAssistantLoopConversationItemKind.AssistantReply: {
        messages.push({ role: ERole.Assistant, content: item.content });
        break;
      }
    }
  }

  return messages;
}

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

  public async requestAssistantTurn(
    args: TRequestAssistantTurnArgs,
  ): Promise<TOption<TRuntimeAssistantTurn>> {
    const model = this.getModel(args.purpose);

    this.logger.info(`Calling ${model}`);
    const baseSystemText = await readBaseSystemText();
    const messages = buildOpenrouterMessages(args, baseSystemText);

    const res = await this.openrouter.chat.send({
      stream: false,
      model,
      messages,
      tools: args.tools.map((tool) => tool.definition),
    });

    const message = res.choices[0]?.message;

    if (!message) {
      this.logger.warning("requestAssistantTurn: no message in response");
      return undefined;
    }

    return {
      response: extractTextContent(message.content),
      toolCalls: message.toolCalls ?? [],
    };
  }
}
