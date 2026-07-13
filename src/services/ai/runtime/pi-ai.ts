import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import { EConfigKey } from "../../settings/schema";
import { readXmlAndInjectConfig } from "../instructions/read-xml-and-inject-config";
import { aiModels, getAiApiKey, getAiModelConfig } from "../providers/registry";
import { EAiProvider, ERole } from "../types";
import type { TRequestAssistantTurnArgs } from "./types";

const BASE_SYSTEM_INSTRUCTIONS_PATH = "./src/services/ai/instructions/base-system.xml";
const SAiProvider = z.enum(EAiProvider);

export function buildPiContext(
  args: TRequestAssistantTurnArgs,
  model: Model<Api>,
  baseSystemText: string,
): Context {
  const systemParts = [baseSystemText];
  const messages: Message[] = [];
  const timestamp = Date.now();

  for (const historyItem of args.history) {
    if (historyItem.role === ERole.System) {
      systemParts.push(historyItem.content);
      continue;
    }

    if (historyItem.role === ERole.User) {
      messages.push({
        role: "user",
        content: historyItem.content,
        timestamp,
      });
      continue;
    }

    messages.push({
      role: "assistant",
      content: [{ type: "text", text: historyItem.content }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp,
    });
  }

  if (args.user !== undefined) {
    systemParts.push(
      `Current user context - always use this user_id for tool calls:\n- user_id: ${args.user.id}\n- username: ${args.user.username}\n- displayName: ${args.user.displayName}`,
    );
  }

  if (args.currentTimeContext !== undefined) {
    systemParts.push(args.currentTimeContext);
  }

  for (const tool of args.tools) {
    if (tool.instructions !== undefined) {
      systemParts.push(tool.instructions);
    }
  }

  messages.push(...args.conversation);

  return {
    systemPrompt: systemParts.join("\n\n"),
    messages,
    tools: args.tools.map((tool) => tool.definition),
  };
}

export async function requestAssistantTurn(
  args: TRequestAssistantTurnArgs,
): Promise<AssistantMessage> {
  const parsedProvider = SAiProvider.safeParse(args.settings[EConfigKey.AiProvider]);

  if (!parsedProvider.success) {
    throw new Error(`Unknown AI provider: ${args.settings[EConfigKey.AiProvider]}`);
  }

  const provider = parsedProvider.data;
  const modelConfig = getAiModelConfig(provider, args.purpose);
  const model = modelConfig.model;
  const baseSystemText = await readXmlAndInjectConfig(BASE_SYSTEM_INSTRUCTIONS_PATH, args.settings);
  const context = buildPiContext(args, model, baseSystemText);
  const options: SimpleStreamOptions = {
    apiKey: getAiApiKey(provider),
  };

  if (modelConfig.effort !== undefined) {
    options.reasoning = modelConfig.effort;
  }

  if (args.trace !== undefined) {
    options.sessionId = args.trace.turnId;
  }

  return aiModels.completeSimple(model, context, options);
}
