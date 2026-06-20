import type { TOption } from "../../../types";
import { createLogger } from "../../../utils/logger";
import { EConfigKey, type TConfigRecord } from "../../settings/schema";
import { OllamaAiProvider } from "../providers/ollama";
import { OpencodeGoAiProvider } from "../providers/opencode-go";
import { OpenrouterAiProvider } from "../providers/openrouter";
import {
  runAssistantToolLoop,
  runToolTask,
  type TAssistantToolLoopArgs,
  type TAssistantToolLoopResult,
  type TRequestAssistantTurnArgs,
  type TRuntimeAssistantTurn,
  type TRuntimeUser,
  type TToolTaskArgs,
  type TToolTaskResult,
} from "../runtime";
import { EAiProvider } from "../types";

export type {
  TAssistantToolActivity,
  TAssistantToolLoopArgs,
  TAssistantToolLoopResult,
  TNormalizedToolResult,
  TRuntimeUser,
  TToolTaskArgs,
  TToolTaskResult,
} from "../runtime";
export { EAssistantLoopStopReason } from "../runtime";
export {
  DEFINE_MESSAGE_IMPORTANCE_TOOL,
  defineMessageImportanceTool,
} from "../tools/define-message-importance/definition";
export type { TDefineMessageImportance } from "../tools/define-message-importance/handler";
export { SEARCH_MEMORY_TOOL, searchMemoryTool } from "../tools/search-memory/definition";
export type { TSearchMemory } from "../tools/search-memory/handler";
export { WEB_FETCH_TOOL, webFetchTool } from "../tools/web-fetch/definition";
export type { TWebFetch } from "../tools/web-fetch/handler";
export { WEB_SEARCH_TOOL, webSearchTool } from "../tools/web-search/definition";
export type { TWebSearch } from "../tools/web-search/handler";
export type { THistoryItem, TPrompt } from "../types";
export { EAiProvider, EModelPurpose, ERole } from "../types";
export type TAiUser = TRuntimeUser;

type TAiProviderInstance = {
  requestAssistantTurn: (
    args: TRequestAssistantTurnArgs,
  ) => Promise<TOption<TRuntimeAssistantTurn>>;
};

export class AiConnector {
  private static _instance: AiConnector;
  private logger = createLogger("AI CONNECTOR");

  private constructor() {
    this.logger.info("AiConnector initialized");
  }

  public static get instance(): AiConnector {
    if (!AiConnector._instance) {
      AiConnector._instance = new AiConnector();
    }

    return AiConnector._instance;
  }

  private selectProvider(settings: TConfigRecord): TAiProviderInstance {
    const providerName = settings[EConfigKey.AiProvider];

    switch (providerName) {
      case EAiProvider.Ollama: {
        return OllamaAiProvider.instance;
      }
      case EAiProvider.Openrouter: {
        return OpenrouterAiProvider.instance;
      }
      case EAiProvider.OpencodeGo: {
        return OpencodeGoAiProvider.instance;
      }
      default: {
        throw new Error(`Unknown AI provider: ${providerName}`);
      }
    }
  }

  public async runAssistantToolLoop(
    args: TAssistantToolLoopArgs,
  ): Promise<TAssistantToolLoopResult> {
    if (args.requestAssistantTurn !== undefined) {
      return runAssistantToolLoop({ ...args, requestAssistantTurn: args.requestAssistantTurn });
    }

    const provider = this.selectProvider(args.settings);
    return runAssistantToolLoop({
      ...args,
      requestAssistantTurn: provider.requestAssistantTurn.bind(provider),
    });
  }

  public async runToolTask(args: TToolTaskArgs): Promise<TToolTaskResult> {
    const provider = this.selectProvider(args.settings);
    return runToolTask({
      ...args,
      requestAssistantTurn: provider.requestAssistantTurn.bind(provider),
    });
  }
}
