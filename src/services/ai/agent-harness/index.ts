import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  type Api,
  contentText,
  createAssistantMessageEventStream,
  type Model,
  type Static,
  Type,
} from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import type { TOption } from "../../../types";
import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "../../app-logger";
import {
  sanitizeErrorMessage,
  sanitizeToolCallArguments,
  sanitizeToolResult,
  sanitizeToolResultError,
} from "../../app-logger/sanitizers";
import { EMessagePlatform } from "../../messaging/types";
import { EConfigKey, type TConfigRecord } from "../../settings/schema";
import { readXmlAndInjectConfig } from "../instructions/read-xml-and-inject-config";
import { aiModels, getAiApiKey, getAiModelConfig } from "../providers/registry";
import {
  createMemoryTools,
  createSchedulingTools,
  createSettingsTools,
  createWebTools,
  type TToolExecutionContext,
} from "../tools/executable";
import { EAiProvider, EModelPurpose, ERole, type THistoryItem } from "../types";
import { EAgentName, type TAgentRunArgs, type TAgentRunResult } from "./types";

const BASE_INSTRUCTIONS_PATH = "./src/services/ai/instructions/base-system.xml";
const SEQUENTIAL: "sequential" = "sequential";
const PARALLEL: "parallel" = "parallel";
const AGENT_INSTRUCTIONS: Record<EAgentName, string> = {
  [EAgentName.Main]: "./src/services/ai/agents/main/instructions.xml",
  [EAgentName.Memory]: "./src/services/ai/agents/memory/instructions.xml",
  [EAgentName.Settings]: "./src/services/ai/agents/settings/instructions.xml",
  [EAgentName.Scheduling]: "./src/services/ai/agents/scheduling/instructions.xml",
  [EAgentName.ScheduledTask]: "./src/services/ai/agents/scheduled-task/instructions.xml",
};
const TOOL_INSTRUCTIONS = {
  searchMemory: "./src/services/ai/tools/search-memory/instructions.xml",
  getSettings: "./src/services/ai/tools/get-settings/instructions.xml",
  updateSettings: "./src/services/ai/tools/update-settings/instructions.xml",
  listCronJobs: "./src/services/ai/tools/list-cron-jobs/instructions.xml",
  scheduleOnce: "./src/services/ai/tools/schedule-once/instructions.xml",
  scheduleRecurring: "./src/services/ai/tools/schedule-recurring/instructions.xml",
  unscheduleCronJob: "./src/services/ai/tools/unschedule-cron-job/instructions.xml",
  updateCronJob: "./src/services/ai/tools/update-cron-job/instructions.xml",
  webSearch: "./src/services/ai/tools/web-search/instructions.xml",
  webFetch: "./src/services/ai/tools/web-fetch/instructions.xml",
} as const;

export class AgentHarness {
  private static _instance: TOption<AgentHarness>;

  public static get instance(): AgentHarness {
    if (AgentHarness._instance === undefined) {
      AgentHarness._instance = new AgentHarness();
    }

    return AgentHarness._instance;
  }

  public async runMain(
    args: Omit<TAgentRunArgs, "name" | "purpose" | "maxIterations">,
  ): Promise<TAgentRunResult> {
    let delegationCount = 0;

    return this.run({
      ...args,
      name: EAgentName.Main,
      purpose: EModelPurpose.ChatAccurate,
      maxIterations: 30,
      delegationCount: () => {
        delegationCount += 1;

        if (delegationCount > 30) {
          throw new Error("Root delegation limit reached");
        }
      },
    });
  }

  public async runScheduledTask(
    args: Omit<TAgentRunArgs, "name" | "purpose" | "maxIterations">,
  ): Promise<TAgentRunResult> {
    return this.run({
      ...args,
      name: EAgentName.ScheduledTask,
      purpose: EModelPurpose.ChatAccurate,
      maxIterations: 30,
      delegationCount: undefined,
    });
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
    const modelConfig = this.resolveModel(args.settings, args.purpose);
    this.logDirectCompletionStarted(
      args.trace,
      modelConfig.model.provider,
      modelConfig.model.id,
      args.purpose,
    );
    let result: Awaited<ReturnType<typeof aiModels.completeSimple>>;

    try {
      result = await aiModels.completeSimple(
        modelConfig.model,
        {
          systemPrompt: args.instructions,
          messages: [{ role: "user", content: args.prompt, timestamp: Date.now() }],
          tools: [],
        },
        {
          apiKey: this.resolveApiKey(modelConfig.model.provider),
          reasoning: modelConfig.effort,
          signal: args.signal,
        },
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

    if (result.stopReason === "error" || result.stopReason === "aborted") {
      this.logDirectCompletionCompleted(
        args.trace,
        modelConfig.model.provider,
        modelConfig.model.id,
        args.purpose,
        startedAt,
        false,
        result.stopReason,
        0,
        result.errorMessage,
      );
      return undefined;
    }

    const text = contentText(result.content).trim();

    if (text.length === 0) {
      this.logDirectCompletionCompleted(
        args.trace,
        modelConfig.model.provider,
        modelConfig.model.id,
        args.purpose,
        startedAt,
        false,
        "blank",
        0,
        undefined,
      );
      return undefined;
    }

    this.logDirectCompletionCompleted(
      args.trace,
      modelConfig.model.provider,
      modelConfig.model.id,
      args.purpose,
      startedAt,
      true,
      result.stopReason,
      text.length,
      undefined,
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
      });

      if (response === undefined) {
        return `Provider returned no response for ${purpose}`;
      }
    }

    return undefined;
  }

  private async run(
    args: TAgentRunArgs & { delegationCount: TOption<() => void> },
  ): Promise<TAgentRunResult> {
    const modelConfig = this.resolveModel(args.settings, args.purpose);
    const systemPrompt = await this.createSystemPrompt(args);
    const tools = await this.createTools(args);
    let iterations = 0;
    let toolCallCount = 0;
    let lastToolBatch: TOption<string>;
    let finalText: TOption<string>;
    let stopReason = "completed";
    let forceFinalization = false;
    let forcedFinalAttempt = false;
    let providerCallCount = 0;
    const startedAt = performance.now();
    const toolStartedAt = new Map<string, number>();

    const messages = this.createHistory(
      args.history,
      modelConfig.model.api,
      modelConfig.model.provider,
      modelConfig.model.id,
    );
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: modelConfig.model,
        thinkingLevel: modelConfig.effort,
        tools,
        messages,
      },
      streamFn: (model, context, options) => {
        if (providerCallCount >= args.maxIterations) {
          return createHardLimitStream(model);
        }

        providerCallCount += 1;
        return aiModels.streamSimple(model, context, options);
      },
      getApiKey: (provider) => this.resolveApiKey(provider),
      toolExecution: "parallel",
      prepareNextTurnWithContext: (context) => {
        iterations += 1;

        if (context.message.role !== "assistant") {
          return undefined;
        }

        const hasToolCall = context.message.content.some((content) => content.type === "toolCall");

        if (!hasToolCall) {
          return undefined;
        }

        if (forcedFinalAttempt) {
          stopReason = "forced-finalization-failed";
          agent.abort();
          return undefined;
        }

        if (forceFinalization || iterations >= args.maxIterations - 1) {
          forcedFinalAttempt = true;
          return {
            context: {
              systemPrompt: `${context.context.systemPrompt}\n\nTool budget reached. Do not call tools. Give the final answer using available results.`,
              messages: context.context.messages,
              tools: [],
            },
          };
        }

        return undefined;
      },
    });

    agent.subscribe((event) => {
      if (event.type === "turn_end") {
        const message = event.message;

        if (message.role === "assistant") {
          const toolCalls = message.content.filter((content) => content.type === "toolCall");
          const signature = JSON.stringify(
            toolCalls.map((toolCall) => [toolCall.name, canonicalize(toolCall.arguments)]),
          );

          if (toolCalls.length > 0 && signature === lastToolBatch) {
            forceFinalization = true;
          }

          if (toolCalls.length > 0) {
            lastToolBatch = signature;
          } else {
            const text = contentText(message.content).trim();

            if (text.length > 0) {
              finalText = text;
            }
          }
        }
      }

      if (event.type === "tool_execution_start") {
        toolCallCount += 1;
        toolStartedAt.set(event.toolCallId, performance.now());
        this.logToolStarted(args, event.toolCallId, event.toolName, event.args);
      }

      if (event.type === "tool_execution_end") {
        this.logToolCompleted(
          args,
          event.toolCallId,
          event.toolName,
          event.result,
          event.isError,
          toolStartedAt.get(event.toolCallId),
        );
        toolStartedAt.delete(event.toolCallId);
      }

      return undefined;
    });

    this.logStarted(args, modelConfig.model.provider, modelConfig.model.id);
    const abort = () => agent.abort();
    args.signal?.addEventListener("abort", abort, { once: true });

    try {
      if (args.signal?.aborted) {
        stopReason = "aborted";
      } else {
        await agent.prompt(args.prompt);
      }
    } catch (error) {
      stopReason = "error";
      this.logFailure(
        args,
        modelConfig.model.provider,
        modelConfig.model.id,
        startedAt,
        String(error),
      );
      throw error;
    } finally {
      args.signal?.removeEventListener("abort", abort);
    }

    const terminalAssistant = agent.state.messages.toReversed().find((message) => {
      return message.role === "assistant";
    });

    if (
      terminalAssistant !== undefined &&
      !terminalAssistant.content.some((content) => content.type === "toolCall") &&
      terminalAssistant.stopReason !== "error" &&
      terminalAssistant.stopReason !== "aborted"
    ) {
      const text = contentText(terminalAssistant.content).trim();

      if (text.length > 0) {
        finalText = text;
      }
    }

    if (args.signal?.aborted) {
      stopReason = "aborted";
      finalText = undefined;
    } else if (stopReason === "forced-finalization-failed") {
      finalText = undefined;
    } else if (agent.state.errorMessage !== undefined && finalText === undefined) {
      stopReason = "error";
      finalText = undefined;
    } else if (iterations >= args.maxIterations) {
      stopReason = "iteration-limit";
    }

    this.logCompleted(
      args,
      modelConfig.model.provider,
      modelConfig.model.id,
      iterations,
      toolCallCount,
      finalText,
      stopReason,
      startedAt,
    );
    return { text: finalText, iterations, toolCallCount, stopReason };
  }

  private resolveModel(settings: TConfigRecord, purpose: EModelPurpose) {
    const provider = settings[EConfigKey.AiProvider];

    switch (provider) {
      case EAiProvider.OpenaiCodex:
      case EAiProvider.Openrouter:
      case EAiProvider.Ollama:
      case EAiProvider.OpencodeGo:
        return getAiModelConfig(provider, purpose);
      default:
        throw new Error(`Unknown AI provider: ${provider}`);
    }
  }

  private resolveApiKey(provider: string): TOption<string> {
    switch (provider) {
      case EAiProvider.OpenaiCodex:
        return getAiApiKey(EAiProvider.OpenaiCodex);
      case EAiProvider.Openrouter:
        return getAiApiKey(EAiProvider.Openrouter);
      case EAiProvider.Ollama:
        return getAiApiKey(EAiProvider.Ollama);
      case EAiProvider.OpencodeGo:
        return getAiApiKey(EAiProvider.OpencodeGo);
      default:
        return undefined;
    }
  }

  private createHistory(
    history: THistoryItem[] | undefined,
    api: Api,
    provider: string,
    model: string,
  ): AgentMessage[] {
    if (history === undefined) {
      return [];
    }

    const timestamp = Date.now();
    const messages: AgentMessage[] = [];

    for (const item of history) {
      if (item.role === ERole.System) {
        continue;
      }

      if (item.role === ERole.User) {
        messages.push({ role: "user", content: item.content, timestamp });
        continue;
      }

      messages.push({
        role: "assistant",
        content: [{ type: "text", text: item.content }],
        api,
        provider,
        model,
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

    return messages;
  }

  private async createSystemPrompt(args: TAgentRunArgs): Promise<string> {
    const toolPaths = this.getToolInstructionPaths(args.name);
    const [base, agentInstructions, ...toolInstructions] = await Promise.all([
      readXmlAndInjectConfig(BASE_INSTRUCTIONS_PATH, args.settings),
      readXmlAndInjectConfig(AGENT_INSTRUCTIONS[args.name], args.settings),
      ...toolPaths.map((path) => readXmlAndInjectConfig(path, args.settings)),
    ]);
    const parts = [base, agentInstructions, ...toolInstructions];

    if (args.currentTimeContext !== undefined) {
      parts.push(args.currentTimeContext);
    }

    if (args.platform === EMessagePlatform.Signal) {
      parts.push(
        "You are replying through Signal. Use only Signal styled-text syntax: *italic*, **bold**, `monospace`, ~strikethrough~, and ||spoiler||. Use short paragraphs and simple lists. Never use headings, tables, blockquotes, embeds, or Discord mentions.",
      );
    }

    if (args.platform === EMessagePlatform.Discord) {
      parts.push("You are replying through Discord direct messages.");
    }

    return parts.join("\n\n");
  }

  private async createTools(args: TAgentRunArgs & { delegationCount: TOption<() => void> }) {
    const context: TToolExecutionContext = {
      chatId: args.chatId,
      settings: args.settings,
      verifySettings: this.verifySettings.bind(this),
    };
    switch (args.name) {
      case EAgentName.Main:
        return [...createWebTools(), ...this.createDelegationTools(args)];
      case EAgentName.Memory:
        return createMemoryTools(context);
      case EAgentName.Settings:
        return createSettingsTools(context);
      case EAgentName.Scheduling:
        return [...createSchedulingTools(context), ...createWebTools()];
      case EAgentName.ScheduledTask:
        return [...createMemoryTools(context), ...createWebTools()];
    }
  }

  private getToolInstructionPaths(name: EAgentName): string[] {
    switch (name) {
      case EAgentName.Main:
        return [TOOL_INSTRUCTIONS.webSearch, TOOL_INSTRUCTIONS.webFetch];
      case EAgentName.Memory:
        return [TOOL_INSTRUCTIONS.searchMemory];
      case EAgentName.Settings:
        return [TOOL_INSTRUCTIONS.getSettings, TOOL_INSTRUCTIONS.updateSettings];
      case EAgentName.Scheduling:
        return [
          TOOL_INSTRUCTIONS.listCronJobs,
          TOOL_INSTRUCTIONS.scheduleOnce,
          TOOL_INSTRUCTIONS.scheduleRecurring,
          TOOL_INSTRUCTIONS.unscheduleCronJob,
          TOOL_INSTRUCTIONS.updateCronJob,
          TOOL_INSTRUCTIONS.webSearch,
          TOOL_INSTRUCTIONS.webFetch,
        ];
      case EAgentName.ScheduledTask:
        return [
          TOOL_INSTRUCTIONS.searchMemory,
          TOOL_INSTRUCTIONS.webSearch,
          TOOL_INSTRUCTIONS.webFetch,
        ];
    }
  }

  private createDelegationTools(args: TAgentRunArgs & { delegationCount: TOption<() => void> }) {
    const schema = Type.Object({
      task: Type.String({ minLength: 1, description: "Focused task for the specialist" }),
    });
    const delegates: Array<{
      name: string;
      label: string;
      target: EAgentName;
      purpose: EModelPurpose;
    }> = [
      {
        name: "delegate-memory",
        label: "Delegate memory",
        target: EAgentName.Memory,
        purpose: EModelPurpose.ToolAccurate,
      },
      {
        name: "delegate-settings",
        label: "Delegate settings",
        target: EAgentName.Settings,
        purpose: EModelPurpose.ToolAccurate,
      },
      {
        name: "delegate-scheduling",
        label: "Delegate scheduling",
        target: EAgentName.Scheduling,
        purpose: EModelPurpose.ChatAccurate,
      },
    ];

    return delegates.map((delegate) => ({
      name: delegate.name,
      label: delegate.label,
      description: `Run the ${delegate.target} specialist for this focused task`,
      parameters: schema,
      executionMode: delegate.target === EAgentName.Scheduling ? SEQUENTIAL : PARALLEL,
      execute: async (toolCallId: string, parameters: unknown, signal?: AbortSignal) => {
        if (args.delegationCount === undefined) {
          throw new Error("Specialists cannot delegate");
        }

        const parsedParameters: Static<typeof schema> = Value.Decode(schema, parameters);
        args.delegationCount();
        let delegationSignal = args.signal;

        if (signal !== undefined) {
          delegationSignal = signal;
        }

        const result = await this.run({
          ...args,
          name: delegate.target,
          purpose: delegate.purpose,
          prompt: `Original user message:\n${args.prompt}\n\nDelegated task:\n${parsedParameters.task}`,
          history: undefined,
          maxIterations: 12,
          parentToolCallId: toolCallId,
          delegationCount: undefined,
          signal: delegationSignal,
        });

        if (result.text === undefined || result.text.trim().length === 0) {
          throw new Error(`${delegate.target} specialist returned no final response`);
        }

        return {
          content: [{ type: "text" as const, text: result.text }],
          details: result,
        };
      },
    }));
  }

  private logStarted(args: TAgentRunArgs, provider: string, model: string) {
    if (args.trace === undefined) {
      return;
    }

    AppLogger.instance.record({
      trace: args.trace,
      event: "agent.started",
      component: "agent-harness",
      provider,
      model,
      purpose: args.purpose,
      summary: `${args.name} agent started`,
      metadata: { agentName: args.name, parentToolCallId: args.parentToolCallId ?? null },
    });
  }

  private logCompleted(
    args: TAgentRunArgs,
    provider: string,
    model: string,
    iterations: number,
    toolCallCount: number,
    text: TOption<string>,
    stopReason: string,
    startedAt: number,
  ) {
    if (args.trace === undefined) {
      return;
    }

    AppLogger.instance.record({
      trace: args.trace,
      event: "agent.completed",
      component: "agent-harness",
      provider,
      model,
      purpose: args.purpose,
      success: text !== undefined,
      durationMs: performance.now() - startedAt,
      summary: `${args.name} agent completed`,
      metadata: {
        agentName: args.name,
        parentToolCallId: args.parentToolCallId ?? null,
        iterations,
        toolCallCount,
        stopReason,
        responseChars: text?.length ?? 0,
      },
    });
  }

  private logToolStarted(
    args: TAgentRunArgs,
    toolCallId: string,
    toolName: string,
    toolArgs: unknown,
  ) {
    if (args.trace === undefined) {
      return;
    }

    const details = sanitizeToolCallArguments({ id: "", name: toolName, arguments: toolArgs });
    AppLogger.instance.record({
      trace: args.trace,
      event: "tool.call.started",
      component: "agent-harness",
      toolName,
      summary: details.summary,
      metadata: {
        ...details.metadata,
        agentName: args.name,
        toolCallId,
        parentToolCallId: args.parentToolCallId ?? null,
      },
    });
  }

  private logToolCompleted(
    args: TAgentRunArgs,
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
    startedAt: TOption<number>,
  ) {
    if (args.trace === undefined) {
      return;
    }

    let resultDetails: unknown = result;
    let resultError: TOption<string>;

    if (isRecord(result)) {
      resultDetails = result.details;

      if (isError && Array.isArray(result.content)) {
        resultError = contentText(result.content).trim();
      }
    }

    const details = sanitizeToolResult({
      toolCallId,
      toolName,
      success: !isError,
      data: resultDetails,
      error: resultError,
    });
    const error = sanitizeToolResultError({
      toolCallId,
      toolName,
      success: !isError,
      data: resultDetails,
      error: resultError,
    });
    AppLogger.instance.record({
      trace: args.trace,
      event: "tool.call.completed",
      component: "agent-harness",
      level: isError ? EBehaviorLogLevel.Warning : EBehaviorLogLevel.Info,
      toolName,
      success: !isError,
      durationMs: startedAt === undefined ? undefined : performance.now() - startedAt,
      summary: details.summary,
      metadata: {
        ...details.metadata,
        agentName: args.name,
        toolCallId,
        parentToolCallId: args.parentToolCallId ?? null,
      },
      error,
    });
  }

  private logFailure(
    args: TAgentRunArgs,
    provider: string,
    model: string,
    startedAt: number,
    error: TOption<string>,
  ) {
    if (args.trace === undefined) {
      return;
    }

    AppLogger.instance.record({
      trace: args.trace,
      event: "agent.completed",
      component: "agent-harness",
      level: EBehaviorLogLevel.Error,
      provider,
      model,
      purpose: args.purpose,
      success: false,
      durationMs: performance.now() - startedAt,
      summary: `${args.name} agent failed`,
      metadata: {
        agentName: args.name,
        parentToolCallId: args.parentToolCallId ?? null,
        stopReason: "error",
      },
      error: sanitizeErrorMessage(error),
    });
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

    AppLogger.instance.record({
      trace,
      event: "direct-completion.completed",
      component: "agent-harness",
      level: success ? EBehaviorLogLevel.Info : EBehaviorLogLevel.Warning,
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

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    const normalized: Record<string, unknown> = {};

    for (const [key, child] of entries) {
      normalized[key] = canonicalize(child);
    }

    return normalized;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createHardLimitStream(model: Model<Api>) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant" as const,
    content: [],
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
    stopReason: "error" as const,
    errorMessage: "Agent iteration limit reached",
    timestamp: Date.now(),
  };

  queueMicrotask(() => {
    stream.push({ type: "error", reason: "error", error: message });
    stream.end(message);
  });

  return stream;
}

export type { TAgentRunResult } from "./types";
export { EAgentName } from "./types";
