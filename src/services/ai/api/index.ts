import type { TOption } from "../../../types";
import { createLogger } from "../../../utils/logger";
import { sanitizeErrorMessage } from "../../app-logger/sanitizers";
import type { TConfigRecord } from "../../settings/schema";
import {
  runAssistantToolLoop,
  runToolTask,
  type TAssistantToolLoopArgs,
  type TAssistantToolLoopResult,
  type TRuntimeUser,
  type TToolTaskArgs,
  type TToolTaskResult,
} from "../runtime";
import { requestAssistantTurn } from "../runtime/pi-ai";
import { extractAssistantText, normalizeError } from "../runtime/serialization";
import { type EModelPurpose, ERole } from "../types";

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
export {
  DEFINE_SETTINGS_INTENT_TOOL,
  defineSettingsIntentTool,
} from "../tools/define-settings-intent/definition";
export type { TDefineSettingsIntent } from "../tools/define-settings-intent/handler";
export { GET_SETTINGS_TOOL, getSettingsTool } from "../tools/get-settings/definition";
export type { TGetSettingsArgs } from "../tools/get-settings/handler";
export { SEARCH_MEMORY_TOOL, searchMemoryTool } from "../tools/search-memory/definition";
export type { TSearchMemory } from "../tools/search-memory/handler";
export { UPDATE_SETTINGS_TOOL, updateSettingsTool } from "../tools/update-settings/definition";
export type { TUpdateSettingsArgs } from "../tools/update-settings/handler";
export { WEB_FETCH_TOOL, webFetchTool } from "../tools/web-fetch/definition";
export type { TWebFetch } from "../tools/web-fetch/handler";
export { WEB_SEARCH_TOOL, webSearchTool } from "../tools/web-search/definition";
export type { TWebSearch } from "../tools/web-search/handler";
export type { THistoryItem, TPrompt } from "../types";
export { EAiProvider, EModelPurpose, ERole } from "../types";
export type TAiUser = TRuntimeUser;

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

  public async runAssistantToolLoop(
    args: TAssistantToolLoopArgs,
  ): Promise<TAssistantToolLoopResult> {
    if (args.requestAssistantTurn !== undefined) {
      return runAssistantToolLoop({ ...args, requestAssistantTurn: args.requestAssistantTurn });
    }

    return runAssistantToolLoop({
      ...args,
      requestAssistantTurn,
    });
  }

  public async runToolTask(args: TToolTaskArgs): Promise<TToolTaskResult> {
    return runToolTask({
      ...args,
      requestAssistantTurn,
    });
  }

  public async verifySettings(
    settings: TConfigRecord,
    purposes: EModelPurpose[],
  ): Promise<TOption<string>> {
    for (const purpose of purposes) {
      try {
        const result = await requestAssistantTurn({
          conversation: [
            {
              role: "user",
              content: "Reply with ok.",
              timestamp: Date.now(),
            },
          ],
          history: [{ role: ERole.System, content: "Reply with ok." }],
          user: undefined,
          currentTimeContext: undefined,
          tools: [],
          purpose,
          settings,
        });

        if (result.stopReason === "error" || result.stopReason === "aborted") {
          let reason: string = result.stopReason;
          const sanitizedError = sanitizeErrorMessage(result.errorMessage);

          if (sanitizedError !== undefined) {
            reason = sanitizedError;
          }

          return `Provider failed for ${purpose}: ${reason}`;
        }

        if (extractAssistantText(result).trim().length === 0) {
          return `Provider returned no response for ${purpose}`;
        }
      } catch (error) {
        const sanitizedError = sanitizeErrorMessage(normalizeError(error));

        if (sanitizedError === undefined) {
          return `Provider failed for ${purpose}`;
        }

        return `Provider failed for ${purpose}: ${sanitizedError}`;
      }
    }

    return undefined;
  }
}
