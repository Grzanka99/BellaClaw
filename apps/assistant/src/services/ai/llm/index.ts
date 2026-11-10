import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import {
  type Api,
  type AssistantMessage,
  type Context,
  contentText,
  hasApi,
  type Model,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type ThinkingLevel,
  type Usage,
} from "@earendil-works/pi-ai";
import { sanitizeErrorMessage } from "../../app-logger/sanitizers";
import { EConfigKey, type TConfigRecord } from "../../settings/schema";
import {
  decodeAiModelPreferences,
  getAiModelPreference,
  type TAiServiceTier,
} from "../model-preferences";
import {
  aiModels,
  getAiApiKey,
  getAiModelConfig,
  refreshAiModels,
  supportsAiServiceTier,
} from "../providers/registry";
import { EAiProvider, type EModelPurpose, SAiProvider } from "../types";

export type TLlmModelConfig = ReturnType<typeof getAiModelConfig>;

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// Simple requests cannot carry a service tier or Codex effort "none"; these need full stream options.
function createAiStreamOptions(
  model: Model<Api>,
  options: SimpleStreamOptions,
  effort: TOption<ModelThinkingLevel>,
  serviceTier: TOption<TAiServiceTier>,
) {
  const isCodexEffortOff = effort === "off" && hasApi(model, "openai-codex-responses");

  if (!isCodexEffortOff && (serviceTier === undefined || !supportsAiServiceTier(model))) {
    return undefined;
  }

  let reasoningEffort: TOption<ThinkingLevel | "none">;

  if (isCodexEffortOff) {
    reasoningEffort = "none";
  } else if (effort !== "off") {
    reasoningEffort = effort;
  }

  return { ...options, reasoningEffort, serviceTier };
}

export class LlmClient {
  private static _instance: TOption<LlmClient>;

  public static get instance(): LlmClient {
    if (LlmClient._instance === undefined) {
      LlmClient._instance = new LlmClient();
    }

    return LlmClient._instance;
  }

  public async resolveModel(
    settings: TConfigRecord,
    purpose: EModelPurpose,
    signal?: AbortSignal,
  ): Promise<TLlmModelConfig> {
    const value = settings[EConfigKey.AiProvider];
    const provider = SAiProvider.safeParse(value);

    if (!provider.success) {
      throw new Error(`Unknown AI provider: ${value}`);
    }

    const preferences = decodeAiModelPreferences(settings[EConfigKey.AiModelPreferences]);
    await refreshAiModels(provider.data, false, signal);
    return getAiModelConfig(
      provider.data,
      purpose,
      getAiModelPreference(preferences, provider.data, purpose),
    );
  }

  public resolveApiKey(provider: string): TOption<string> {
    const parsed = SAiProvider.safeParse(provider);

    if (!parsed.success) {
      return undefined;
    }

    return getAiApiKey(parsed.data);
  }

  public sessionHeaders(provider: string, sessionId: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (provider === EAiProvider.OpencodeGo) {
      headers["x-opencode-session"] = sessionId;
    }
    if (provider === EAiProvider.Openrouter) {
      headers["x-session-id"] = sessionId;
    }

    return headers;
  }

  public createSessionId(
    provider: string,
    chatId: TOption<string>,
    platform: TOption<string>,
  ): string {
    if (chatId === undefined) {
      return crypto.randomUUID();
    }

    return new Bun.CryptoHasher("sha256", this.resolveApiKey(provider))
      .update(`${platform ?? "unknown"}:${chatId}`)
      .digest("hex");
  }

  public complete(
    config: TLlmModelConfig,
    context: Context,
    options: SimpleStreamOptions,
    sessionId: string,
  ): Promise<AssistantMessage> {
    const requestOptions = this.withSession(
      { ...options, apiKey: this.resolveApiKey(config.model.provider) },
      config.model.provider,
      sessionId,
    );
    const streamOptions = createAiStreamOptions(
      config.model,
      requestOptions,
      config.effort,
      config.serviceTier,
    );

    if (streamOptions !== undefined) {
      return aiModels.complete(config.model, context, streamOptions);
    }

    let reasoning: TOption<ThinkingLevel>;

    if (config.effort !== "off") {
      reasoning = config.effort;
    }

    return aiModels.completeSimple(config.model, context, { ...requestOptions, reasoning });
  }

  public stream(
    model: Model<Api>,
    config: Pick<TLlmModelConfig, "effort" | "serviceTier">,
    context: Context,
    options: SimpleStreamOptions,
    sessionId: string,
  ) {
    const requestOptions = this.withSession(options, model.provider, sessionId);
    const streamOptions = createAiStreamOptions(
      model,
      requestOptions,
      config.effort,
      config.serviceTier,
    );

    if (streamOptions !== undefined) {
      return aiModels.stream(model, context, streamOptions);
    }

    return aiModels.streamSimple(model, context, requestOptions);
  }

  public async completeText(args: {
    prompt: string;
    instructions: string;
    settings: TConfigRecord;
    purpose: EModelPurpose;
    trace: TOption<TBehaviorTraceContext>;
    signal?: AbortSignal;
  }): Promise<TOption<string>> {
    const startedAt = performance.now();
    const modelConfig = await this.resolveModel(args.settings, args.purpose, args.signal);
    const sessionId = this.createSessionId(
      modelConfig.model.provider,
      args.trace?.chatId,
      args.trace?.platform,
    );
    this.logDirectCompletionStarted(
      args.trace,
      modelConfig.model.provider,
      modelConfig.model.id,
      args.purpose,
    );
    let result: AssistantMessage;

    try {
      result = await this.complete(
        modelConfig,
        {
          systemPrompt: args.instructions,
          messages: [{ role: "user", content: args.prompt, timestamp: Date.now() }],
          tools: [],
        },
        { signal: args.signal },
        sessionId,
      );
    } catch (error) {
      this.logDirectCompletionCompleted(
        args.trace,
        modelConfig.model.provider,
        modelConfig.model.id,
        args.purpose,
        startedAt,
        false,
        "error",
        0,
        String(error),
      );
      throw error;
    }

    this.logModelRequestCompleted({
      trace: args.trace,
      purpose: args.purpose,
      agentName: undefined,
      parentToolCallId: undefined,
      iteration: 1,
      startedAt,
      message: result,
    });

    let text: TOption<string>;
    let stopReason: string = result.stopReason;
    if (result.stopReason !== "error" && result.stopReason !== "aborted") {
      const response = contentText(result.content).trim();
      if (response.length > 0) {
        text = response;
      } else {
        stopReason = "blank";
      }
    }

    this.logDirectCompletionCompleted(
      args.trace,
      modelConfig.model.provider,
      modelConfig.model.id,
      args.purpose,
      startedAt,
      text !== undefined,
      stopReason,
      text?.length ?? 0,
      result.errorMessage,
    );
    return text;
  }

  public async verifySettings(
    settings: TConfigRecord,
    purposes: EModelPurpose[],
  ): Promise<TOption<string>> {
    for (const purpose of purposes) {
      const response = await this.completeText({
        prompt: "Reply with ok.",
        instructions: "Reply with ok.",
        settings,
        purpose,
        trace: undefined,
        signal: AbortSignal.timeout(60_000),
      });

      if (response === undefined) {
        return `Provider returned no response for ${purpose}`;
      }
    }

    return undefined;
  }

  public logModelRequestCompleted(args: {
    trace: TOption<TBehaviorTraceContext>;
    purpose: EModelPurpose;
    agentName: TOption<string>;
    parentToolCallId: TOption<string>;
    iteration: number;
    startedAt: number;
    message: AssistantMessage;
  }) {
    if (args.trace === undefined) {
      return;
    }

    const { usage, stopReason } = args.message;
    const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    let cacheHitPercent: number | null = null;
    if (inputTokens > 0) {
      cacheHitPercent = (usage.cacheRead / inputTokens) * 100;
    }

    const success = stopReason !== "error" && stopReason !== "aborted";
    let level = EBehaviorLogLevel.Info;
    if (!success) {
      level = EBehaviorLogLevel.Warning;
    }

    AppLogger.instance.record({
      trace: args.trace,
      event: "model.request.completed",
      component: "agent-harness",
      provider: args.message.provider,
      model: args.message.model,
      purpose: args.purpose,
      level,
      success,
      durationMs: performance.now() - args.startedAt,
      summary: `model request completed cacheRead=${usage.cacheRead} inputTokens=${inputTokens}`,
      error: sanitizeErrorMessage(args.message.errorMessage),
      metadata: {
        agentName: args.agentName ?? null,
        parentToolCallId: args.parentToolCallId ?? null,
        iteration: args.iteration,
        stopReason,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        inputTokens,
        cacheHitPercent,
      },
    });
  }

  private withSession(
    options: SimpleStreamOptions,
    provider: string,
    sessionId: string,
  ): SimpleStreamOptions {
    return {
      ...options,
      sessionId,
      headers: { ...options.headers, ...this.sessionHeaders(provider, sessionId) },
    };
  }

  private logDirectCompletionStarted(
    trace: TOption<TBehaviorTraceContext>,
    provider: string,
    model: string,
    purpose: EModelPurpose,
  ) {
    if (trace === undefined) {
      return;
    }

    AppLogger.instance.record({
      trace,
      event: "direct-completion.started",
      component: "agent-harness",
      provider,
      model,
      purpose,
      summary: "direct completion started",
    });
  }

  private logDirectCompletionCompleted(
    trace: TOption<TBehaviorTraceContext>,
    provider: string,
    model: string,
    purpose: EModelPurpose,
    startedAt: number,
    success: boolean,
    stopReason: string,
    responseChars: number,
    error: TOption<string>,
  ) {
    if (trace === undefined) {
      return;
    }

    let level = EBehaviorLogLevel.Warning;

    if (success) {
      level = EBehaviorLogLevel.Info;
    }

    AppLogger.instance.record({
      trace,
      event: "direct-completion.completed",
      component: "agent-harness",
      level,
      provider,
      model,
      purpose,
      success,
      durationMs: performance.now() - startedAt,
      summary: "direct completion completed",
      metadata: { stopReason, responseChars },
      error: sanitizeErrorMessage(error),
    });
  }
}
