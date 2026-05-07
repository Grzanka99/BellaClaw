import type { ToolDefinitionJson } from "@openrouter/sdk/models";
import { Config } from "../../../config";
import type { TOption } from "../../../types";
import { createLogger } from "../../../utils/logger";
import { OllamaAiProvider } from "../providers/ollama";
import { OpenrouterAiProvider } from "../providers/openrouter";
import type {
  EModelPurpose,
  TChatWithTools,
  THistoryItem,
  TPrompt,
  TToolCallResponse,
  TToolEntry,
} from "../types";
import { EAiProvider } from "../types";

export {
  DEFINE_MESSAGE_IMPORTANCE_TOOL,
  defineMessageImportanceTool,
} from "../tools/define-message-importance/definition";
export type { TDefineMessageImportance } from "../tools/define-message-importance/handler";
export { SEARCH_MEMORY_TOOL, searchMemoryTool } from "../tools/search-memory/definition";
export type { TSearchMemory } from "../tools/search-memory/handler";
export type { THistoryItem, TPrompt } from "../types";
export { EAiProvider, EModelPurpose, ERole } from "../types";

export type TAiUser = {
  username: string;
  id: string;
  displayName: string;
};

export type TChatWithToolsArgs = {
  prompt: TPrompt;
  history: THistoryItem[];
  user: TAiUser;
  tools: TToolEntry[];
  purpose: EModelPurpose;
};

export type TToolCallArgs = {
  prompt: TPrompt;
  instructions: THistoryItem[];
  tools: ToolDefinitionJson[];
  purpose: EModelPurpose;
  chatId?: string;
};

export class AiConnector {
  private static _instance: AiConnector;
  private logger = createLogger("AI CONNECTOR");
  private providerName = Config.ai.provider;

  private constructor() {
    this.logger.info(`Using provider: ${this.providerName}`);
  }

  public static get instance(): AiConnector {
    if (!AiConnector._instance) {
      AiConnector._instance = new AiConnector();
    }

    return AiConnector._instance;
  }

  private get provider() {
    switch (this.providerName) {
      case EAiProvider.Ollama: {
        return OllamaAiProvider.instance;
      }
      case EAiProvider.Openrouter: {
        return OpenrouterAiProvider.instance;
      }
      default: {
        return OllamaAiProvider.instance;
      }
    }
  }

  public async chatWithTools(args: TChatWithToolsArgs): Promise<TOption<TChatWithTools>> {
    return this.provider.chatWithTools(args);
  }

  public async toolCall<T = unknown>(args: TToolCallArgs): Promise<TOption<TToolCallResponse<T>>> {
    return this.provider.toolCall<T>(args);
  }
}
