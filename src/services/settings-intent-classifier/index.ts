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
import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "../app-logger";
import { resolveAiBehaviorFields } from "../app-logger/ai";
import { sanitizeErrorMessage } from "../app-logger/sanitizers";
import { SettingsService } from "../settings";
import { createStableAiRuntimeSettings, type TConfigRecord } from "../settings/schema";

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

  public async classify(
    message: string,
    ownerKey: string,
    trace?: TBehaviorTraceContext,
  ): Promise<TOption<TSettingsIntent>> {
    const start = performance.now();
    this.logger.info(`classify: start for owner ${ownerKey}`);
    let runtimeSettings: TOption<TConfigRecord>;

    try {
      const settings = await SettingsService.instance.getAll(ownerKey);
      runtimeSettings = createStableAiRuntimeSettings(settings);
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
        trace,
      });

      const toolResult = result.toolResults.find(
        (r) => r.toolName === DEFINE_SETTINGS_INTENT_TOOL && r.success,
      );

      if (toolResult === undefined) {
        this.logger.warning(
          `classify: no successful ${DEFINE_SETTINGS_INTENT_TOOL} tool result (${(performance.now() - start).toFixed(0)}ms)`,
        );
        logSettingsIntentCompleted(trace, runtimeSettings, start, false, undefined, undefined);
        return undefined;
      }

      const parsed = SDefineSettingsIntent.safeParse(toolResult.data);

      if (!parsed.success) {
        this.logger.warning(
          `classify: malformed tool result: ${parsed.error.message} (${(performance.now() - start).toFixed(0)}ms)`,
        );
        logSettingsIntentCompleted(
          trace,
          runtimeSettings,
          start,
          false,
          undefined,
          parsed.error.message,
        );
        return undefined;
      }

      this.logger.info(
        `classify: done — intent=${parsed.data.intent} (${(performance.now() - start).toFixed(0)}ms)`,
      );
      logSettingsIntentCompleted(
        trace,
        runtimeSettings,
        start,
        true,
        parsed.data.intent,
        undefined,
      );
      return parsed.data;
    } catch (error) {
      this.logger.error(
        `classify: failed for owner ${ownerKey}: ${String(error)} (${(performance.now() - start).toFixed(0)}ms)`,
      );
      logSettingsIntentCompleted(trace, runtimeSettings, start, false, undefined, String(error));
      return undefined;
    }
  }
}

function logSettingsIntentCompleted(
  trace: TOption<TBehaviorTraceContext>,
  settings: TOption<TConfigRecord>,
  start: number,
  success: boolean,
  intent: TOption<string>,
  error: TOption<string>,
) {
  if (trace === undefined) {
    return;
  }

  let level = EBehaviorLogLevel.Info;

  if (!success) {
    level = EBehaviorLogLevel.Warning;
  }

  let fields: TOption<ReturnType<typeof resolveAiBehaviorFields>>;

  if (settings !== undefined) {
    fields = resolveAiBehaviorFields(settings, EModelPurpose.ToolCheap);
  }

  AppLogger.instance.record({
    trace,
    event: "settings_intent.completed",
    component: "settings-intent",
    level,
    provider: fields?.provider,
    model: fields?.model,
    purpose: EModelPurpose.ToolCheap,
    success,
    durationMs: performance.now() - start,
    summary: `settings intent completed intent=${intent ?? "unknown"}`,
    metadata: {
      intent: intent ?? "unknown",
    },
    error: sanitizeErrorMessage(error),
  });
}
