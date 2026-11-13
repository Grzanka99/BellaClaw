import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import { createLogger, type TOption } from "@bellaclaw/shared";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  type Api,
  contentText,
  createAssistantMessageEventStream,
  type ImageContent,
  type Message,
  type Model,
  type TextContent,
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
import type { TToolLogPolicy } from "../../app-logger/sanitizers";
import {
  sanitizeToolCallArguments,
  sanitizeToolResult,
  sanitizeToolResultError,
} from "../../app-logger/sanitizers";
import { startSpan, type TBehaviorSpan } from "../../app-logger/span";
import { compactConversation } from "../../conversation/compaction";
import {
  attachmentBlock,
  conversationMessages,
  SAttachmentBlock,
  type TConversation,
} from "../../conversation/types";
import { McpService } from "../../mcp";
import { loadMcpProfiles } from "../../mcp/config";
import { McpRunRegistry, type TMcpRunStatus } from "../../mcp/runs";
import { createMcpSamplingRequest, createMcpSamplingResult } from "../../mcp/sampling";
import type { TAttachmentRef } from "../../messaging/types";
import type { TConfigRecord } from "../../settings/schema";
import { AGENTS, EAgentName } from "../agents";
import baseInstructions from "../instructions/base-system.xml" with { type: "text" };
import { createPlatformInstructions } from "../instructions/platform";
import { readXmlAndInjectConfig } from "../instructions/read-xml-and-inject-config";
import { emptyUsage, LlmClient } from "../llm";
import { aiModels } from "../providers/registry";
import { type TToolExecutionContext, validateToolArguments } from "../tools/define-tool";
import { EModelPurpose } from "../types";
import type { TAgentRunArgs, TAgentRunResult, TMainAgentRunResult } from "./types";

const SEQUENTIAL: "sequential" = "sequential";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const NO_VISION_NOTE = "[User sent an image; the current model cannot view images]";
const TOO_LARGE_NOTE = "[User sent an image; it is larger than 5 MB and was not loaded]";
const FETCH_FAILED_NOTE = "[User sent an image; it could not be loaded from the chat platform]";

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
    args: Omit<TAgentRunArgs, "name" | "parentToolCallId">,
  ): Promise<TMainAgentRunResult> {
    let delegationCount = 0;

    return this.run({
      ...args,
      name: EAgentName.Main,
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
    args: Omit<TAgentRunArgs, "name" | "parentToolCallId">,
  ): Promise<TAgentRunResult> {
    return this.run({
      ...args,
      name: EAgentName.ScheduledTask,
      parentToolCallId: undefined,
      delegationCount: undefined,
    });
  }

  public async compactConversation(
    state: TConversation,
    settings: TConfigRecord,
    chatId: string,
    platform: TAgentRunArgs["platform"],
    trace: TBehaviorTraceContext,
    events: TAgentRunArgs["events"],
  ) {
    const config = await this.llm.resolveModel(settings, AGENTS[EAgentName.Main].purpose);
    const args = {
      name: EAgentName.Main,
      settings,
      chatId,
      platform,
      prompt: "",
      currentTimeContext: undefined,
      trace,
      events,
      signal: undefined,
      parentToolCallId: undefined,
      delegationCount: undefined,
    };
    const tools = await this.createTools(args);
    const systemPrompt = await this.createSystemPrompt(args);
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
    const agentDefinition = AGENTS[args.name];
    const modelConfig = await this.llm.resolveModel(
      args.settings,
      agentDefinition.purpose,
      args.signal,
    );
    const tools = await this.createTools(args);
    const systemPrompt = await this.createSystemPrompt(args);
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
      purpose: agentDefinition.purpose,
    });
    let requestSpan: TOption<TBehaviorSpan>;
    const sessionId = this.llm.createSessionId(
      modelConfig.model.provider,
      args.chatId,
      args.platform,
    );

    const toolSpans = new Map<string, TBehaviorSpan>();
    const toolLogPolicies = new Map<string, TToolLogPolicy>(
      agentDefinition.tools.map((tool) => [tool.name, tool]),
    );
    for (const target of agentDefinition.delegates) {
      toolLogPolicies.set(`delegate-${target}`, {
        logSafe: [],
        privateErrors: false,
        previews: ["task", "text"],
      });
    }

    let messages: AgentMessage[] = [];
    if (args.conversation !== undefined) {
      const conversation = await this.withImages(args.conversation, modelConfig.model, args);
      messages = structuredClone(conversationMessages(conversation));
    }
    const promptImages = await Promise.all(
      (args.images?.refs ?? []).map((ref) => this.resolveImage(ref, modelConfig.model, args)),
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
        if (iterations >= agentDefinition.maxIterations) {
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

        if (forceFinalization || iterations >= agentDefinition.maxIterations - 1) {
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
          purpose: agentDefinition.purpose,
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
        const details = sanitizeToolCallArguments(
          event.toolName,
          event.args,
          toolLogPolicies.get(event.toolName),
        );
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
        const logPolicy = toolLogPolicies.get(event.toolName);
        const details = sanitizeToolResult(result, logPolicy);

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
            error: sanitizeToolResultError(result, logPolicy),
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
      purpose: agentDefinition.purpose,
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
        await agent.prompt({
          role: "user",
          content: [{ type: "text", text: prompt }, ...promptImages],
          timestamp: Date.now(),
        });

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
    } else if (iterations >= agentDefinition.maxIterations) {
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
    let transcript: Message[] = (await agent.convertToLlm(agent.state.messages)).filter(
      (message) => message.role !== "system",
    );
    if (args.conversation !== undefined && args.conversation.summary.length > 0) {
      transcript = transcript.slice(1);
    }
    // NOTE: the caller stores the transcript; image bytes go back to references
    let promptIndex = 0;
    if (args.conversation !== undefined) {
      promptIndex = args.conversation.entries.length;
      transcript = [
        ...args.conversation.entries.map((entry) => entry.message),
        ...transcript.slice(promptIndex),
      ];
    }
    const refs = args.images?.refs ?? [];
    const promptMessage = transcript[promptIndex];
    if (refs.length > 0 && promptMessage?.role === "user" && Array.isArray(promptMessage.content)) {
      transcript[promptIndex] = {
        ...promptMessage,
        content: [
          ...promptMessage.content.slice(0, promptMessage.content.length - refs.length),
          ...refs.map(attachmentBlock),
        ],
      };
    }
    return { text: finalText, iterations, toolCallCount, stopReason, messages: transcript };
  }

  // NOTE: images in the uncompacted history are fetched again on every turn
  private async withImages(
    conversation: TConversation,
    model: Model<Api>,
    args: TAgentRunArgs,
  ): Promise<TConversation> {
    const entries = await Promise.all(
      conversation.entries.map(async (entry) => {
        const message = entry.message;
        if (message.role !== "user" || typeof message.content === "string") {
          return entry;
        }

        const content = await Promise.all(
          message.content.map((block) => {
            const parsed = SAttachmentBlock.safeParse(block);
            if (!parsed.success) {
              return block;
            }

            return this.resolveImage(parsed.data.attachment, model, args);
          }),
        );
        return { ...entry, message: { ...message, content } };
      }),
    );
    return { ...conversation, entries };
  }

  private async resolveImage(
    ref: TAttachmentRef,
    model: Model<Api>,
    args: TAgentRunArgs,
  ): Promise<ImageContent | TextContent> {
    let block: ImageContent | TextContent = { type: "text", text: FETCH_FAILED_NOTE };
    if (!model.input.includes("image")) {
      block = { type: "text", text: NO_VISION_NOTE };
    } else if (args.images !== undefined) {
      try {
        const data = await args.images.fetch(ref, MAX_IMAGE_BYTES);
        if (data === undefined) {
          block = { type: "text", text: TOO_LARGE_NOTE };
        } else {
          block = {
            type: "image",
            data: Buffer.from(data).toString("base64"),
            mimeType: ref.mimeType,
          };
        }
      } catch (error) {
        this.logger.warning(`resolveImage: fetch failed: ${String(error)}`);
      }
    }

    let level = EBehaviorLogLevel.Info;
    let outcome = "attached";
    if (block.type === "text") {
      level = EBehaviorLogLevel.Warning;
      outcome = `replaced by note ${block.text}`;
    }
    AppLogger.instance.record({
      trace: args.trace,
      event: "agent.image.resolved",
      component: "agent-harness",
      level,
      model: model.id,
      summary: `[Image ${ref.mimeType}] ${outcome}`,
      metadata: { agentName: args.name, mimeType: ref.mimeType },
    });
    return block;
  }

  private async createSystemPrompt(args: TAgentRunArgs): Promise<string> {
    const agentDefinition = AGENTS[args.name];
    const parts = [
      baseInstructions,
      agentDefinition.instructions,
      ...agentDefinition.tools.map((tool) => tool.instructions),
    ].map((instructions) => readXmlAndInjectConfig(instructions, args.settings));

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
      runScheduledTask: (runArgs) => {
        return this.runScheduledTask(runArgs);
      },
      events: args.events,
    };
    const agentDefinition = AGENTS[args.name];
    const tools = [
      ...agentDefinition.tools.map((tool) => tool.createAgentTool(context)),
      ...this.createDelegationTools(args),
    ];

    if (agentDefinition.mcp && args.withoutMcp !== true) {
      tools.push(...(await this.createMcpDelegationTools(args)));
    }

    if (args.mcp !== undefined) {
      tools.push(...args.mcp.tools);
    }

    return tools;
  }

  private createDelegationTools(
    args: TAgentRunArgs & { delegationCount: TOption<() => void> },
  ): AgentTool[] {
    const schema = obj(
      {
        task: str({ minLength: 1, description: "Focused task for the specialist" }),
      },
      { open: true },
    );

    return AGENTS[args.name].delegates.map((target) => {
      const delegation = AGENTS[target].delegation;

      if (delegation === undefined) {
        throw new Error(`${target} agent cannot be delegated to`);
      }

      return {
        name: `delegate-${target}`,
        label: `Delegate ${target}`,
        description: delegation.description,
        parameters: schema,
        executionMode: delegation.mode,
        execute: async (toolCallId: string, parameters: unknown, signal?: AbortSignal) => {
          const parsedParameters: Static<typeof schema> = validateToolArguments(schema, parameters);
          args.delegationCount?.();
          let delegationSignal = args.signal;

          if (signal !== undefined) {
            delegationSignal = signal;
          }

          let images: TAgentRunArgs["images"];
          if (AGENTS[target].purpose === EModelPurpose.SpecialistAccurate) {
            images = args.images;
          }

          const result = await this.run({
            ...args,
            name: target,
            images,
            prompt: `Original user message:\n${args.prompt}\n\nDelegated task:\n${parsedParameters.task}`,
            conversation: undefined,
            parentToolCallId: toolCallId,
            delegationCount: undefined,
            signal: delegationSignal,
          });

          if (result.text === undefined || result.text.trim().length === 0) {
            throw new Error(`${target} specialist returned no final response`);
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
                  prompt: this.createMcpPrompt(args.prompt, parsed.task, parsed.context),
                  conversation: undefined,
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
  let candidates: unknown[] = [parsed];

  if (Array.isArray(parsed)) {
    candidates = parsed;
  }

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
