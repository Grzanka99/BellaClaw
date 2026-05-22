import { Config } from "../../../config";
import { createLogger } from "../../../utils/logger";
import { OllamaAiProvider } from "../providers/ollama";
import { OpenrouterAiProvider } from "../providers/openrouter";
import {
  runAssistantToolLoop,
  runToolTask,
  type TAssistantToolLoopArgs,
  type TAssistantToolLoopResult,
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
export type { THistoryItem, TPrompt } from "../types";
export { EAiProvider, EModelPurpose, ERole } from "../types";
export type TAiUser = TRuntimeUser;

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

  public async runAssistantToolLoop(
    args: TAssistantToolLoopArgs,
  ): Promise<TAssistantToolLoopResult> {
    return runAssistantToolLoop({
      ...args,
      requestAssistantTurn:
        args.requestAssistantTurn ?? this.provider.requestAssistantTurn.bind(this.provider),
    });
  }

  public async runToolTask(args: TToolTaskArgs): Promise<TToolTaskResult> {
    return runToolTask({
      ...args,
      requestAssistantTurn: this.provider.requestAssistantTurn.bind(this.provider),
    });
  }
}
