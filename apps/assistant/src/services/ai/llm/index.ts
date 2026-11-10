import { AppLogger, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
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
import type { z } from "zod";
import { startSpan, type TBehaviorSpan } from "../../app-logger/span";
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

// NOTE: retryable separates a missing reply (a transient model outage) from a reply the model did
// produce but that cannot be used, which callers may retry or give up on
export class LlmResponseError extends Error {
  public readonly retryable: boolean;

  public constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "LlmResponseError";
    this.retryable = retryable;
  }
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
    trace: TBehaviorTraceContext;
    signal?: AbortSignal;
  }): Promise<TOption<string>> {
    const requestSpan = startSpan(args.trace, "model.request.completed", "agent-harness");
    const completionSpan = startSpan(args.trace, "direct-completion.completed", "agent-harness");
    const modelConfig = await this.resolveModel(args.settings, args.purpose, args.signal);
    const sessionId = this.createSessionId(
      modelConfig.model.provider,
      args.trace.chatId,
      args.trace.platform,
    );
    const completionFields = {
      provider: modelConfig.model.provider,
      model: modelConfig.model.id,
      purpose: args.purpose,
    };
    AppLogger.instance.record({
      trace: args.trace,
      event: "direct-completion.started",
      component: "agent-harness",
      ...completionFields,
      summary: "direct completion started",
    });
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
      completionSpan.fail(String(error), {
        ...completionFields,
        summary: "direct completion completed",
        metadata: { stopReason: "error", responseChars: 0 },
      });
      throw error;
    }

    this.logModelRequestCompleted({
      span: requestSpan,
      purpose: args.purpose,
      agentName: undefined,
      parentToolCallId: undefined,
      iteration: 1,
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

    completionSpan.end(
      text !== undefined,
      {
        ...completionFields,
        summary: "direct completion completed",
        metadata: { stopReason, responseChars: text?.length ?? 0 },
      },
      result.errorMessage,
    );
    return text;
  }

  public async completeJson<T>(
    schema: z.ZodType<T>,
    args: Parameters<LlmClient["completeText"]>[0],
  ): Promise<T> {
    const response = await this.completeText(args);

    if (response === undefined) {
      throw new LlmResponseError("model returned no response", true);
    }

    let responseJson: unknown;
    try {
      responseJson = JSON.parse(response);
    } catch (error) {
      throw new LlmResponseError(`response was not valid JSON: ${String(error)}`, false);
    }

    const parsed = schema.safeParse(responseJson);
    if (!parsed.success) {
      throw new LlmResponseError("response did not match expected shape", false);
    }

    return parsed.data;
  }

  public async verifySettings(
    settings: TConfigRecord,
    purposes: EModelPurpose[],
    trace: TBehaviorTraceContext,
  ): Promise<TOption<string>> {
    for (const purpose of purposes) {
      const response = await this.completeText({
        prompt: "Reply with ok.",
        instructions: "Reply with ok.",
        settings,
        purpose,
        trace,
        signal: AbortSignal.timeout(60_000),
      });

      if (response === undefined) {
        return `Provider returned no response for ${purpose}`;
      }
    }

    return undefined;
  }

  public logModelRequestCompleted(args: {
    span: TBehaviorSpan;
    purpose: EModelPurpose;
    agentName: TOption<string>;
    parentToolCallId: TOption<string>;
    iteration: number;
    message: AssistantMessage;
  }) {
    const { usage, stopReason } = args.message;
    const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    let cacheHitPercent: number | null = null;
    if (inputTokens > 0) {
      cacheHitPercent = (usage.cacheRead / inputTokens) * 100;
    }

    args.span.end(
      stopReason !== "error" && stopReason !== "aborted",
      {
        provider: args.message.provider,
        model: args.message.model,
        purpose: args.purpose,
        summary: `model request completed cacheRead=${usage.cacheRead} inputTokens=${inputTokens}`,
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
      },
      args.message.errorMessage,
    );
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
}
