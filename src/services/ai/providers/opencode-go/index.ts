import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import z from "zod";
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
import { normalizeError, promptToText, serializeForModel } from "../../runtime/serialization";
import { EModelPurpose, ERole } from "../../types";
import { convertToolsForOpencodeGo } from "./converters";

export type TOpencodeGoModel =
  (typeof Config.ai.providers.opencodeGo.models)[keyof typeof Config.ai.providers.opencodeGo.models];

const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPENCODE_API_KEY = Bun.env.OPENCODE_API_KEY ?? "";

const BASE_SYSTEM_INSTRUCTIONS_PATH = "./src/services/ai/instructions/base-system.xml";

const SOpencodeGoToolCall = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.unknown(),
  }),
});

const SOpencodeGoChatResponse = z.object({
  choices: z.array(
    z.object({
      message: z
        .object({
          content: z.string().nullable().optional(),
          reasoning_content: z.string().nullable().optional(),
          tool_calls: z.array(SOpencodeGoToolCall).optional(),
        })
        .optional(),
    }),
  ),
});

export type TOpencodeGoRequestMessage = {
  role: string;
  content: string | null;
  tool_calls?: ChatMessageToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
};

type TOpencodeGoToolCall = z.infer<typeof SOpencodeGoToolCall>;
type TOpencodeGoFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type TOpencodeGoChatResponse = z.infer<typeof SOpencodeGoChatResponse>;

function buildUserContextMessage(user: TRuntimeUser): TOpencodeGoRequestMessage {
  return {
    role: ERole.System,
    content: `Current user context - always use this user_id for tool calls:\n- user_id: ${user.id}\n- username: ${user.username}\n- displayName: ${user.displayName}`,
  };
}

function stringifyToolArguments(argumentsValue: unknown): string {
  if (typeof argumentsValue === "string") {
    return argumentsValue;
  }

  return serializeForModel(argumentsValue);
}

export async function readBaseSystemText(): Promise<string> {
  return readXmlAndInjectConfig(BASE_SYSTEM_INSTRUCTIONS_PATH, Config);
}

export function buildOpencodeGoMessages(
  args: TRequestAssistantTurnArgs,
  baseSystemText: string,
): TOpencodeGoRequestMessage[] {
  const messages: TOpencodeGoRequestMessage[] = [{ role: ERole.System, content: baseSystemText }];

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
        messages.push({
          role: item.prompt.role,
          content: promptToText(item.prompt),
        });
        break;
      }
      case EAssistantLoopConversationItemKind.AssistantToolCalls: {
        let content: string | null = null;

        if (item.content.trim().length > 0) {
          content = item.content;
        }

        const message: TOpencodeGoRequestMessage = {
          role: ERole.Assistant,
          content,
          tool_calls: item.toolCalls,
          reasoning_content: item.reasoningContent ?? "",
        };

        messages.push(message);
        break;
      }
      case EAssistantLoopConversationItemKind.ToolResult: {
        messages.push({
          role: "tool",
          content: serializeForModel(item.result),
          tool_call_id: item.result.toolCallId,
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

export function normalizeOpencodeGoToolCalls(
  toolCalls: TOpencodeGoToolCall[] | undefined,
): ChatMessageToolCall[] {
  return (toolCalls ?? []).map((toolCall) => ({
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.function.name,
      arguments: stringifyToolArguments(toolCall.function.arguments),
    },
  }));
}

export async function opencodeGoChat(
  body: Record<string, unknown>,
  fetchFn: TOpencodeGoFetch = fetch,
): Promise<TOpencodeGoChatResponse> {
  const res = await fetchFn(`${OPENCODE_GO_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENCODE_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();

    throw new Error(`OpenCode Go API error: ${res.status} ${res.statusText}: ${errorText}`);
  }

  let responseJson: unknown;

  try {
    responseJson = await res.json();
  } catch (error) {
    throw new Error(`Failed to parse OpenCode Go response: ${normalizeError(error)}`);
  }

  const parsed = SOpencodeGoChatResponse.safeParse(responseJson);

  if (!parsed.success) {
    throw new Error("Malformed OpenCode Go chat response");
  }

  return parsed.data;
}

export class OpencodeGoAiProvider {
  private static _instance: OpencodeGoAiProvider;
  private logger = createLogger("OPENCODE GO PROVIDER");

  private constructor() {
    this.logger.info("provider initialized");
  }

  public static get instance(): OpencodeGoAiProvider {
    if (!OpencodeGoAiProvider._instance) {
      OpencodeGoAiProvider._instance = new OpencodeGoAiProvider();
    }

    return OpencodeGoAiProvider._instance;
  }

  public getModel(purpose: EModelPurpose): TOpencodeGoModel {
    const { models } = Config.ai.providers.opencodeGo;

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

    this.logger.info(`requestAssistantTurn: start, model=${model}`);
    const baseSystemText = await readBaseSystemText();
    const messages = buildOpencodeGoMessages(args, baseSystemText);

    const res = await opencodeGoChat({
      model,
      messages,
      tools: convertToolsForOpencodeGo(args.tools.map((tool) => tool.definition)),
      stream: false,
    });

    const message = res.choices[0]?.message;

    if (!message) {
      this.logger.warning("requestAssistantTurn: no message in response");
      return undefined;
    }

    const responseText = message.content ?? "";
    const toolCalls = normalizeOpencodeGoToolCalls(message.tool_calls);

    this.logger.info(
      `requestAssistantTurn: done, response length=${responseText.length}, toolCalls=${toolCalls.length}`,
    );
    return {
      response: responseText,
      toolCalls,
      reasoningContent: message.reasoning_content ?? undefined,
    };
  }
}
