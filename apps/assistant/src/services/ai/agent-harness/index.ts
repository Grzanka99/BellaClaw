import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import { createLogger, type TOption } from "@bellaclaw/shared";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  type Api,
  contentText,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import {
  arr,
  bool,
  map,
  num,
  obj,
  oneOf,
  opt,
  type Static,
  str,
  union,
} from "@earendil-works/pi-schema";
import type {
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageResultWithTools,
  ElicitRequest,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  sanitizeToolCallArguments,
  sanitizeToolResult,
  sanitizeToolResultError,
} from "../../app-logger/sanitizers";
import { startSpan, type TBehaviorSpan } from "../../app-logger/span";
import { compactConversation } from "../../conversation/compaction";
import { conversationMessages, type TConversation } from "../../conversation/types";
import { McpService } from "../../mcp";
import { loadMcpProfiles } from "../../mcp/config";
import { McpRunRegistry, type TMcpRunStatus } from "../../mcp/runs";
import { createMcpSamplingRequest, createMcpSamplingResult } from "../../mcp/sampling";
import type { TConfigRecord } from "../../settings/schema";
import { createPlatformInstructions } from "../instructions/platform";
import { readXmlAndInjectConfig } from "../instructions/read-xml-and-inject-config";
import { emptyUsage, LlmClient } from "../llm";
import { aiModels } from "../providers/registry";
import { validateToolArguments } from "../tools/definition";
import {
  createCalendarTools,
  createMemoryTools,
  createSchedulingTools,
  createSettingsTools,
  createWebTools,
  type TToolExecutionContext,
} from "../tools/executable";
import { EModelPurpose, ERole, type THistoryItem } from "../types";
import {
  EAgentName,
  type TAgentRunArgs,
  type TAgentRunResult,
  type TMainAgentRunResult,
} from "./types";

const BASE_INSTRUCTIONS_PATH = "./src/services/ai/instructions/base-system.xml";
const SEQUENTIAL: "sequential" = "sequential";
const PARALLEL: "parallel" = "parallel";
const AGENT_INSTRUCTIONS: Record<EAgentName, string> = {
  [EAgentName.Calendar]: "./src/services/ai/agents/calendar/instructions.xml",
  [EAgentName.Main]: "./src/services/ai/agents/main/instructions.xml",
  [EAgentName.Mcp]: "./src/services/ai/agents/mcp/instructions.xml",
  [EAgentName.Memory]: "./src/services/ai/agents/memory/instructions.xml",
  [EAgentName.Settings]: "./src/services/ai/agents/settings/instructions.xml",
  [EAgentName.Scheduling]: "./src/services/ai/agents/scheduling/instructions.xml",
  [EAgentName.ScheduledTask]: "./src/services/ai/agents/scheduled-task/instructions.xml",
};

export class AgentHarness {
  private static _instance: TOption<AgentHarness>;
  private logger = createLogger("AGENT_HARNESS");
  private llm = LlmClient.instance;

  public static get instance(): AgentHarness {
    if (AgentHarness._instance === undefined) {
      AgentHarness._instance = new AgentHarness();
    }

    return AgentHarness._instance;
  }

  public async runMain(
    args: Omit<TAgentRunArgs, "name" | "purpose" | "maxIterations" | "parentToolCallId">,
  ): Promise<TMainAgentRunResult> {
    let delegationCount = 0;

    return this.run({
      ...args,
      name: EAgentName.Main,
      purpose: EModelPurpose.Main,
      maxIterations: 30,
      parentToolCallId: undefined,
      delegationCount: () => {
        delegationCount += 1;

        if (delegationCount > 30) {
          throw new Error("Root delegation limit reached");
        }
      },
    });
  }

  public async runScheduledTask(
    args: Omit<TAgentRunArgs, "name" | "purpose" | "maxIterations" | "parentToolCallId">,
  ): Promise<TAgentRunResult> {
    return this.run({
      ...args,
      name: EAgentName.ScheduledTask,
      purpose: EModelPurpose.ScheduledTask,
      maxIterations: 30,
      parentToolCallId: undefined,
      delegationCount: undefined,
    });
  }

  public async compactConversation(
    state: TConversation,
    settings: TConfigRecord,
    chatId: string,
    platform: TAgentRunArgs["platform"],
    commands: string,
    trace: TBehaviorTraceContext,
  ) {
    const config = await this.llm.resolveModel(settings, EModelPurpose.Main);
    const args = {
      name: EAgentName.Main,
      purpose: EModelPurpose.Main,
      settings,
      commands,
      chatId,
      platform,
      prompt: "",
      history: [],
      currentTimeContext: undefined,
      trace,
      signal: undefined,
      maxIterations: 30,
      parentToolCallId: undefined,
      delegationCount: undefined,
    };
    const tools = await this.createTools(args);
    const systemPrompt = await this.createSystemPrompt(args, tools);
    const fixedTokens = Math.ceil(
      (systemPrompt.length +
        JSON.stringify(
          tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
        ).length) /
        4,
    );
    const sessionId = this.llm.createSessionId(config.model.provider, chatId, platform);
    const model = {
      ...config.model,
      headers: {
        ...config.model.headers,
        ...this.llm.sessionHeaders(config.model.provider, sessionId),
      },
    };
    return compactConversation(state, aiModels, model, fixedTokens, trace);
  }

  private async run(
    args: TAgentRunArgs & { delegationCount: TOption<() => void> },
  ): Promise<TMainAgentRunResult> {
    const modelConfig = await this.llm.resolveModel(args.settings, args.purpose, args.signal);
    const tools = await this.createTools(args);
    const systemPrompt = await this.createSystemPrompt(args, tools);
    let iterations = 0;
    let toolCallCount = 0;
    let lastToolBatch: TOption<string>;
    let finalText: TOption<string>;
    let stopReason = "completed";
    let forceFinalization = false;
    let forcedFinalAttempt = false;
    const agentSpan = startSpan(args.trace, "agent.completed", "agent-harness", {
      provider: modelConfig.model.provider,
      model: modelConfig.model.id,
      purpose: args.purpose,
    });
    let requestSpan: TOption<TBehaviorSpan>;
    const sessionId = this.llm.createSessionId(
      modelConfig.model.provider,
      args.chatId,
      args.platform,
    );

    const toolSpans = new Map<string, TBehaviorSpan>();

    let messages = this.createHistory(
      args.history,
      modelConfig.model.api,
      modelConfig.model.provider,
      modelConfig.model.id,
    );
    if (args.conversation !== undefined) {
      messages = structuredClone(conversationMessages(args.conversation));
    }
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: modelConfig.model,
        thinkingLevel: modelConfig.effort,
        tools,
        messages,
      },
      streamFn: (model, context, options) => {
        if (iterations >= args.maxIterations) {
          return createHardLimitStream(model);
        }

        iterations += 1;
        requestSpan = startSpan(args.trace, "model.request.completed", "agent-harness");
        return this.llm.stream(model, modelConfig, context, options ?? {}, sessionId);
      },
      getApiKey: (provider) => this.llm.resolveApiKey(provider),
      toolExecution: "parallel",
      prepareNextTurnWithContext: (context) => {
        let nextTools = context.context.tools;
        if (args.mcp !== undefined) {
          nextTools = [...args.mcp.tools];
          agent.state.tools = nextTools;
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
              messages: context.context.messages,
              tools: [],
            },
            messages: [
              {
                role: "system",
                content: "Tool budget reached. Give the final answer using available results.",
                timestamp: Date.now(),
              },
            ],
          };
        }

        if (nextTools !== context.context.tools) {
          return { context: { ...context.context, tools: nextTools } };
        }

        return undefined;
      },
    });

    agent.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        requestSpan !== undefined
      ) {
        this.llm.logModelRequestCompleted({
          span: requestSpan,
          purpose: args.purpose,
          agentName: args.name,
          parentToolCallId: args.parentToolCallId,
          iteration: iterations,
          message: event.message,
        });
        requestSpan = undefined;
      }

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
          }
        }
      }

      if (event.type === "tool_execution_start") {
        toolCallCount += 1;
        toolSpans.set(
          event.toolCallId,
          startSpan(args.trace, "tool.call.completed", "agent-harness", {
            toolName: event.toolName,
          }),
        );
        const details = sanitizeToolCallArguments({
          id: "",
          name: event.toolName,
          arguments: event.args,
        });
        AppLogger.instance.record({
          trace: args.trace,
          event: "tool.call.started",
          component: "agent-harness",
          toolName: event.toolName,
          summary: details.summary,
          metadata: {
            ...details.metadata,
            agentName: args.name,
            toolCallId: event.toolCallId,
            parentToolCallId: args.parentToolCallId ?? null,
          },
        });
      }

      if (event.type === "tool_execution_end") {
        let resultDetails: unknown = event.result;
        let resultError: TOption<string>;

        if (isRecord(event.result)) {
          resultDetails = event.result.details;

          if (event.isError && Array.isArray(event.result.content)) {
            resultError = contentText(event.result.content).trim();
          }
        }

        const result = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          success: !event.isError,
          data: resultDetails,
          error: resultError,
        };
        const details = sanitizeToolResult(result);

        // NOTE: tool errors use the tool-specific sanitizer, so they bypass the span's own one.
        toolSpans.get(event.toolCallId)?.end(
          !event.isError,
          {
            summary: details.summary,
            metadata: {
              ...details.metadata,
              agentName: args.name,
              toolCallId: event.toolCallId,
              parentToolCallId: args.parentToolCallId ?? null,
            },
            error: sanitizeToolResultError(result),
          },
          undefined,
        );
        toolSpans.delete(event.toolCallId);
      }

      return undefined;
    });

    AppLogger.instance.record({
      trace: args.trace,
      event: "agent.started",
      component: "agent-harness",
      provider: modelConfig.model.provider,
      model: modelConfig.model.id,
      purpose: args.purpose,
      summary: `${args.name} agent started`,
      metadata: { agentName: args.name, parentToolCallId: args.parentToolCallId ?? null },
    });
    const abort = () => agent.abort();
    args.signal?.addEventListener("abort", abort, { once: true });

    try {
      if (args.signal?.aborted) {
        stopReason = "aborted";
      } else {
        let prompt = args.prompt;
        if (args.currentTimeContext !== undefined) {
          prompt = `${args.currentTimeContext}\n\n${prompt}`;
        }
        if (args.name === EAgentName.Main && args.chatId !== undefined) {
          const pendingRuns = McpRunRegistry.instance.list(args.chatId);
          if (pendingRuns.length > 0) {
            prompt += `\n\nPending MCP runs awaiting this user's response:\n${JSON.stringify(pendingRuns)}`;
          }
        }
        await agent.prompt(prompt);

        const firstTerminalAssistant = agent.state.messages.toReversed().find((message) => {
          return message.role === "assistant";
        });
        if (
          firstTerminalAssistant !== undefined &&
          isSerializedToolCall(contentText(firstTerminalAssistant.content), tools)
        ) {
          finalText = undefined;
          await agent.prompt(
            "Your previous response printed a tool call instead of invoking it. Try again now. " +
              "Invoke any required registered tool through the native tool mechanism, keeping " +
              "its arguments inside the native call.",
          );
        }
      }
    } catch (error) {
      stopReason = "error";
      agentSpan.fail(String(error), {
        level: EBehaviorLogLevel.Error,
        summary: `${args.name} agent failed`,
        metadata: {
          agentName: args.name,
          parentToolCallId: args.parentToolCallId ?? null,
          stopReason: "error",
        },
      });
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
    } else if (finalText !== undefined && isSerializedToolCall(finalText, tools)) {
      stopReason = "serialized-tool-call";
      finalText = undefined;
    } else if (stopReason === "forced-finalization-failed") {
      finalText = undefined;
    } else if (agent.state.errorMessage !== undefined && finalText === undefined) {
      stopReason = "error";
      finalText = undefined;
    } else if (iterations >= args.maxIterations) {
      stopReason = "iteration-limit";
    }

    // NOTE: an agent that ends without text still completed normally, so it stays at Info level.
    agentSpan.end(
      finalText !== undefined,
      {
        level: EBehaviorLogLevel.Info,
        summary: `${args.name} agent completed`,
        metadata: {
          agentName: args.name,
          parentToolCallId: args.parentToolCallId ?? null,
          iterations,
          toolCallCount,
          stopReason,
          responseChars: finalText?.length ?? 0,
        },
      },
      undefined,
    );
    let transcript = (await agent.convertToLlm(agent.state.messages)).filter(
      (message) => message.role !== "system",
    );
    if (args.conversation !== undefined && args.conversation.summary.length > 0) {
      transcript = transcript.slice(1);
    }
    return { text: finalText, iterations, toolCallCount, stopReason, messages: transcript };
  }

  private createHistory(
    history: TOption<THistoryItem[]>,
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
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp,
      });
    }

    return messages;
  }

  private async createSystemPrompt(
    args: TAgentRunArgs,
    tools: Array<{ instructionsPath?: string } | AgentTool>,
  ): Promise<string> {
    const toolPaths = tools.flatMap((tool) => {
      if (!("instructionsPath" in tool) || tool.instructionsPath === undefined) {
        return [];
      }
      return [tool.instructionsPath];
    });
    const [base, agentInstructions, ...toolInstructions] = await Promise.all([
      readXmlAndInjectConfig(BASE_INSTRUCTIONS_PATH, args.settings, args.commands),
      readXmlAndInjectConfig(AGENT_INSTRUCTIONS[args.name], args.settings, args.commands),
      ...toolPaths.map((path) => readXmlAndInjectConfig(path, args.settings, args.commands)),
    ]);
    const parts = [base, agentInstructions, ...toolInstructions];

    if (args.mcp !== undefined) {
      parts.push(
        `<mcp_profile_instructions>${args.mcp.profile.instructions}</mcp_profile_instructions>`,
      );
    }

    if (args.name === EAgentName.Scheduling) {
      let profiles: Awaited<ReturnType<typeof loadMcpProfiles>> = [];
      try {
        profiles = await loadMcpProfiles();
      } catch (error) {
        this.logger.warning(`MCP profiles unavailable to Scheduling: ${String(error)}`);
      }
      if (profiles.length > 0) {
        const summary = profiles
          .map((profile) => `${profile.id}: ${profile.description}`)
          .join("\n");
        parts.push(`<scheduled_task_mcp_profiles>\n${summary}\n</scheduled_task_mcp_profiles>`);
      }
    }

    const platformInstructions = createPlatformInstructions(args.platform);

    if (platformInstructions !== undefined) {
      parts.push(platformInstructions);
    }

    return parts.join("\n\n");
  }

  private async createTools(args: TAgentRunArgs & { delegationCount: TOption<() => void> }) {
    const context: TToolExecutionContext = {
      chatId: args.chatId,
      settings: args.settings,
      trace: args.trace,
      verifySettings: (settings, purposes) => {
        return this.llm.verifySettings(settings, purposes, args.trace);
      },
    };
    switch (args.name) {
      case EAgentName.Calendar:
        return [...createCalendarTools(context), ...createWebTools()];
      case EAgentName.Main:
        return [
          ...createWebTools(),
          ...this.createDelegationTools(args),
          ...(await this.createMcpDelegationTools(args)),
        ];
      case EAgentName.Mcp:
        if (args.mcp === undefined) {
          return [];
        }
        return args.mcp.tools;
      case EAgentName.Memory:
        return createMemoryTools(context);
      case EAgentName.Settings:
        return createSettingsTools(context);
      case EAgentName.Scheduling:
        return [...createSchedulingTools(context), ...createWebTools()];
      case EAgentName.ScheduledTask:
        return [
          ...createMemoryTools(context).filter((tool) => tool.name === "search-memory"),
          ...createWebTools(),
          ...createCalendarTools(context).filter((tool) => {
            return (
              tool.name === "list-calendar-events" || tool.name === "find-calendar-availability"
            );
          }),
          ...createSchedulingTools(context).filter((tool) => tool.name === "list-cron-jobs"),
          ...(await this.createMcpDelegationTools(args)),
        ];
    }
  }

  private createDelegationTools(args: TAgentRunArgs & { delegationCount: TOption<() => void> }) {
    const schema = obj(
      {
        task: str({ minLength: 1, description: "Focused task for the specialist" }),
      },
      { open: true },
    );
    const delegates: Array<{
      name: string;
      label: string;
      target: EAgentName;
      purpose: EModelPurpose;
    }> = [
      {
        name: "delegate-calendar",
        label: "Delegate calendar",
        target: EAgentName.Calendar,
        purpose: EModelPurpose.SpecialistAccurate,
      },
      {
        name: "delegate-memory",
        label: "Delegate memory",
        target: EAgentName.Memory,
        purpose: EModelPurpose.Specialist,
      },
      {
        name: "delegate-settings",
        label: "Delegate settings",
        target: EAgentName.Settings,
        purpose: EModelPurpose.Specialist,
      },
      {
        name: "delegate-scheduling",
        label: "Delegate scheduling",
        target: EAgentName.Scheduling,
        purpose: EModelPurpose.SpecialistAccurate,
      },
    ];

    return delegates.map((delegate) => {
      let executionMode: typeof SEQUENTIAL | typeof PARALLEL = PARALLEL;
      let description = `Run the ${delegate.target} specialist for this focused task`;

      if (delegate.target === EAgentName.Calendar || delegate.target === EAgentName.Scheduling) {
        executionMode = SEQUENTIAL;
      }

      if (delegate.target === EAgentName.Memory) {
        description =
          "Required for personal user facts and forget requests. Run the Memory specialist to retrieve or forget the relevant facts.";
      }

      return {
        name: delegate.name,
        label: delegate.label,
        description,
        parameters: schema,
        instructionsPath: undefined,
        executionMode,
        execute: async (toolCallId: string, parameters: unknown, signal?: AbortSignal) => {
          const parsedParameters: Static<typeof schema> = validateToolArguments(schema, parameters);
          args.delegationCount?.();
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
            conversation: undefined,
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
            details: {
              text: result.text,
              iterations: result.iterations,
              toolCallCount: result.toolCallCount,
              stopReason: result.stopReason,
            },
          };
        },
      };
    });
  }

  private async createMcpDelegationTools(
    args: TAgentRunArgs & { delegationCount: TOption<() => void> },
  ): Promise<AgentTool[]> {
    let profiles: Awaited<ReturnType<typeof loadMcpProfiles>> = [];
    try {
      profiles = await loadMcpProfiles();
    } catch (error) {
      this.logger.warning(`MCP delegation disabled: ${String(error)}`);
    }
    const profileSummary = profiles
      .map((profile) => `${profile.id}: ${profile.description}`)
      .join("\n");
    const delegateSchema = obj(
      {
        profileId: str({
          minLength: 1,
          description: `One configured profile:\n${profileSummary}`,
        }),
        task: str({ minLength: 1, description: "Focused task for the MCP specialist" }),
        context: str({
          minLength: 1,
          description: "Recent conversation context needed for this task, stated explicitly",
        }),
      },
      { open: true },
    );
    const responseValue = union([str(), num(), bool(), arr(str())]);
    const resumeSchema = obj(
      {
        runId: str({ minLength: 1 }),
        action: oneOf(["accept", "decline", "cancel"]),
        content: opt(map(responseValue)),
      },
      { open: true },
    );
    const cancelSchema = obj({ runId: str({ minLength: 1 }) }, { open: true });
    const tools: AgentTool[] = [
      {
        name: "delegate-mcp",
        label: "Delegate MCP",
        description: `Run one configured MCP specialist. Profiles:\n${profileSummary}`,
        parameters: delegateSchema,
        executionMode: SEQUENTIAL,
        execute: async (toolCallId, parameters, signal) => {
          const parsed = validateToolArguments(delegateSchema, parameters);
          if (args.name === EAgentName.Main) {
            args.delegationCount?.();
          }
          const profile = profiles.find((candidate) => candidate.id === parsed.profileId);
          if (profile === undefined) {
            throw new Error(`Unknown MCP profile: ${parsed.profileId}`);
          }
          const chatId = this.requireMcpChatId(args.chatId);
          const controller = new AbortController();
          const abort = () => controller.abort();
          signal?.addEventListener("abort", abort, { once: true });
          args.signal?.addEventListener("abort", abort, { once: true });
          let sampleCount = 0;
          let forwardElicitation: (
            params: ElicitRequest["params"],
            requestSignal: AbortSignal,
          ) => Promise<ElicitResult> = () => {
            return Promise.reject(new Error("MCP elicitation started before the specialist"));
          };
          try {
            const session = await McpService.instance.open({
              chatId,
              profileId: profile.id,
              turnId: args.trace.turnId,
              signal: controller.signal,
              sample: (params, requestSignal) => {
                sampleCount += 1;
                if (sampleCount > 12) {
                  throw new Error("MCP sampling request limit reached");
                }
                return this.sampleMcp(
                  params,
                  args.settings,
                  args.chatId,
                  args.platform,
                  args.trace,
                  toolCallId,
                  sampleCount,
                  requestSignal,
                );
              },
              elicit: (params, requestSignal) => forwardElicitation(params, requestSignal),
            });
            const status = await McpRunRegistry.instance.start({
              chatId,
              profileId: profile.id,
              inputTimeoutMs: profile.inputTimeoutMs,
              controller,
              close: () => session.close(),
              run: async (runSignal, elicit) => {
                forwardElicitation = elicit;
                const result = await this.run({
                  ...args,
                  name: EAgentName.Mcp,
                  purpose: EModelPurpose.SpecialistAccurate,
                  prompt: this.createMcpPrompt(args.prompt, parsed.task, parsed.context),
                  history: undefined,
                  conversation: undefined,
                  maxIterations: 12,
                  parentToolCallId: toolCallId,
                  signal: AbortSignal.any([runSignal, session.signal]),
                  delegationCount: undefined,
                  mcp: { profile: session.profile, tools: session.tools },
                });
                // Main gets the answer, not the specialist transcript.
                return {
                  text: result.text,
                  iterations: result.iterations,
                  toolCallCount: result.toolCallCount,
                  stopReason: result.stopReason,
                };
              },
            });
            return this.mcpStatusResult(status);
          } finally {
            signal?.removeEventListener("abort", abort);
            args.signal?.removeEventListener("abort", abort);
          }
        },
      },
      {
        name: "resume-mcp",
        label: "Resume MCP",
        description: "Resume an MCP run that requested user input",
        parameters: resumeSchema,
        executionMode: SEQUENTIAL,
        execute: async (_toolCallId, parameters, signal) => {
          const parsed = validateToolArguments(resumeSchema, parameters);
          const status = await McpRunRegistry.instance.resume(
            this.requireMcpChatId(args.chatId),
            parsed.runId,
            { action: parsed.action, content: parsed.content },
            signal,
          );
          return this.mcpStatusResult(status);
        },
      },
      {
        name: "cancel-mcp",
        label: "Cancel MCP",
        description: "Cancel a live MCP run owned by this chat",
        parameters: cancelSchema,
        executionMode: SEQUENTIAL,
        execute: async (_toolCallId, parameters) => {
          const parsed = validateToolArguments(cancelSchema, parameters);
          await McpRunRegistry.instance.cancel(this.requireMcpChatId(args.chatId), parsed.runId);
          return {
            content: [{ type: "text", text: "MCP run cancelled" }],
            details: { status: "cancelled", runId: parsed.runId },
          };
        },
      },
    ];
    if (profiles.length === 0) {
      if (args.chatId === undefined || McpRunRegistry.instance.list(args.chatId).length === 0) {
        return [];
      }
      return tools.slice(1);
    }
    return tools;
  }

  private requireMcpChatId(chatId: TOption<string>): string {
    if (chatId === undefined) {
      throw new Error("MCP delegation requires a chat owner");
    }
    return chatId;
  }

  private createMcpPrompt(original: string, task: string, context: string): string {
    return `Original user message:\n${original}\n\nDelegated task:\n${task}\n\nRelevant context:\n${context}`;
  }

  private mcpStatusResult(status: TMcpRunStatus) {
    const content: [{ type: "text"; text: string }] = [
      { type: "text", text: JSON.stringify(status) },
    ];
    return {
      content,
      details: status,
    };
  }

  private async sampleMcp(
    params: CreateMessageRequest["params"],
    settings: TConfigRecord,
    chatId: TAgentRunArgs["chatId"],
    platform: TAgentRunArgs["platform"],
    trace: TBehaviorTraceContext,
    parentToolCallId: string,
    iteration: number,
    signal: AbortSignal,
  ): Promise<CreateMessageResult | CreateMessageResultWithTools> {
    if (params.toolChoice?.mode === "required") {
      throw new Error("MCP sampling toolChoice mode 'required' is not supported");
    }
    const modelConfig = await this.llm.resolveModel(
      settings,
      EModelPurpose.SpecialistAccurate,
      signal,
    );
    const request = createMcpSamplingRequest(params, modelConfig.model);
    const span = startSpan(trace, "model.request.completed", "agent-harness");
    const sessionId = this.llm.createSessionId(modelConfig.model.provider, chatId, platform);
    const result = await this.llm.complete(
      modelConfig,
      request.context,
      {
        signal,
        maxTokens: Math.min(params.maxTokens, modelConfig.model.maxTokens),
        temperature: params.temperature,
        toolChoice: request.toolChoice,
      },
      sessionId,
    );
    this.llm.logModelRequestCompleted({
      span,
      purpose: EModelPurpose.SpecialistAccurate,
      agentName: EAgentName.Mcp,
      parentToolCallId,
      iteration,
      message: result,
    });
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(result.errorMessage ?? `MCP sampling ${result.stopReason}`);
    }
    return createMcpSamplingResult(result, modelConfig.model.id);
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

// NOTE: matching a quoted tool name anywhere would also catch a legitimate answer that merely shows
// JSON or documents a tool, and the caller discards that answer entirely. Require the payload to
// parse and to actually carry a registered tool name in a call-shaped field.
export function isSerializedToolCall(text: string, tools: Array<{ name: string }>): boolean {
  let payload = text.trim();

  if (payload.startsWith("```")) {
    const fence = payload.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);

    if (fence?.[1] === undefined) {
      return false;
    }

    payload = fence[1].trim();
  }

  if (!payload.startsWith("{") && !payload.startsWith("[")) {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return false;
  }

  const names = new Set(tools.map((tool) => tool.name));
  const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

  return candidates.some((candidate) => {
    if (!isRecord(candidate)) {
      return false;
    }

    const called = candidate.name ?? candidate.tool ?? candidate.tool_name ?? candidate.function;
    const hasArguments =
      "arguments" in candidate || "parameters" in candidate || "input" in candidate;

    return typeof called === "string" && names.has(called) && hasArguments;
  });
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
    usage: emptyUsage(),
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
