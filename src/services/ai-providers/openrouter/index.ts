import { OpenRouter } from "@openrouter/sdk";
import type { AssistantMessage, Message, ToolDefinitionJson } from "@openrouter/sdk/models";
import type { User } from "discord.js";
import type { TOption } from "../../../types";
import { handleDefineMessageImportance } from "../tools/handlers/define-message-importance";
import type { THistoryItem, TPrompt, TToolCallResponse } from "../types";

const OPENROUTER_API_KEY = Bun.env.OPENROUTER_API_KEY as string;

const MODEL = "google/gemini-3-flash-preview" as const;

const BASE_SYSTEM_MESSAGE: TPrompt = {
  role: "system",
  content: [
    {
      type: "text",
      text: "You are a helpful personal assistant. You communicate with your supervisor via discord direct messages, you will be able to schedule reminders, find informasions in past messages, cooperate with user",
    },
    {
      type: "text",
      text: "You should always reply in Polish language. You should always use Europe/Warsaw time.",
    },
    { type: "text", text: "Don't mention your capabilities unless asked." },
  ],
};

function buildUserContextMessage(user: TUserData): TPrompt {
  return {
    role: "system",
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

  private readonly openrouter: OpenRouter = new OpenRouter({ apiKey: OPENROUTER_API_KEY });

  private constructor() { }

  public static get instance(): OpenrouterAiProvider {
    if (!OpenrouterAiProvider._instance) {
      OpenrouterAiProvider._instance = new OpenrouterAiProvider();
    }

    return OpenrouterAiProvider._instance;
  }

  public async chat(
    prompt: TPrompt,
    history: THistoryItem[],
    user: TUserData,
  ): Promise<TOption<string>> {
    const messages: Message[] = [BASE_SYSTEM_MESSAGE, buildUserContextMessage(user), ...history];
    messages.push(prompt);

    const res = await this.openrouter.chat.send({
      stream: false,
      model: MODEL,
      messages,
    });

    const data = res.choices[0]?.message.content;

    if (!data) {
      return undefined;
    }

    return data.toString();
  }

  public async toolCall<T>(
    prompt: TPrompt,
    instructions: THistoryItem[],
    tools: ToolDefinitionJson[],
    model: string = MODEL,
  ): Promise<TOption<TToolCallResponse<T>>> {
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
    const toolCallsResults = [];

    for (const toolCall of toolCalls) {
      switch (toolCall.function?.name) {
        case "define-message-importance":
          toolCallsResults.push(handleDefineMessageImportance(toolCall));
          break;
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
