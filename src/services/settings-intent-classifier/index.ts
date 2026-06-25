import type { TOption } from "../../types";
import { createLogger, type TLogger } from "../../utils/logger";
import { AiConnector, EModelPurpose, ERole, type THistoryItem, type TPrompt } from "../ai/api";
import { readXmlAndInjectConfig } from "../ai/instructions/read-xml-and-inject-config";
import {
  DEFINE_SETTINGS_INTENT_TOOL,
  defineSettingsIntentTool,
} from "../ai/tools/define-settings-intent/definition";
import {
  SDefineSettingsIntent,
  type TDefineSettingsIntent,
} from "../ai/tools/define-settings-intent/handler";
import { SettingsService } from "../settings";
import { createStableAiRuntimeSettings } from "../settings/schema";

export type TSettingsIntent = TDefineSettingsIntent;

const INSTRUCTIONS_PATH = "./src/services/ai/tools/define-settings-intent/instructions.xml";

const CLASSIFIER_SYSTEM_PROMPT = [
  "You are a message routing classifier.",
  "Read the user's message and call the define-settings-intent tool exactly once to classify whether the message is a settings request (intent=settings) or a normal conversational/task message (intent=normal).",
  "If the message contains BOTH a settings change AND a normal task, classify it as settings.",
  "Do not answer the user's question. Only call the tool.",
].join(" ");

export class SettingsIntentClassifier {
  private static _instance: TOption<SettingsIntentClassifier>;
  private logger: TLogger = createLogger("SETTINGS-INTENT");
  private ai = AiConnector.instance;

  private constructor() {}

  public static get instance() {
    if (!SettingsIntentClassifier._instance) {
      SettingsIntentClassifier._instance = new SettingsIntentClassifier();
    }

    return SettingsIntentClassifier._instance;
  }

  public async classify(message: string, ownerKey: string): Promise<TOption<TSettingsIntent>> {
    const start = performance.now();
    this.logger.info(`classify: start for owner ${ownerKey}`);

    try {
      const settings = await SettingsService.instance.getAll(ownerKey);
      const runtimeSettings = createStableAiRuntimeSettings(settings);
      const toolInstructions = await readXmlAndInjectConfig(INSTRUCTIONS_PATH, settings);

      const system: THistoryItem = {
        role: ERole.System,
        content: `${CLASSIFIER_SYSTEM_PROMPT}\n\n${toolInstructions}`,
      };

      const prompt: TPrompt = {
        role: ERole.User,
        content: [{ type: "text", text: message }],
      };

      const result = await this.ai.runToolTask({
        prompt,
        history: [system],
        tools: [{ definition: defineSettingsIntentTool }],
        purpose: EModelPurpose.ToolCheap,
        chatId: undefined,
        user: undefined,
        settings: runtimeSettings,
      });

      const toolResult = result.toolResults.find(
        (r) => r.toolName === DEFINE_SETTINGS_INTENT_TOOL && r.success,
      );

      if (toolResult === undefined) {
        this.logger.warning(
          `classify: no successful ${DEFINE_SETTINGS_INTENT_TOOL} tool result (${(performance.now() - start).toFixed(0)}ms)`,
        );
        return undefined;
      }

      const parsed = SDefineSettingsIntent.safeParse(toolResult.data);

      if (!parsed.success) {
        this.logger.warning(
          `classify: malformed tool result: ${parsed.error.message} (${(performance.now() - start).toFixed(0)}ms)`,
        );
        return undefined;
      }

      this.logger.info(
        `classify: done — intent=${parsed.data.intent} (${(performance.now() - start).toFixed(0)}ms)`,
      );
      return parsed.data;
    } catch (error) {
      this.logger.error(
        `classify: failed for owner ${ownerKey}: ${String(error)} (${(performance.now() - start).toFixed(0)}ms)`,
      );
      return undefined;
    }
  }
}
