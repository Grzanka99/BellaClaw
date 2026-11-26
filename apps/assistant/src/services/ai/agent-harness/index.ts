import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import { createLogger, MAX_IMAGE_BYTES, type TOption } from "@bellaclaw/shared";
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
import type { TToolLogPolicy } from "../../app-logger/sanitizers";
import {
  sanitizeToolCallArguments,
  sanitizeToolResult,
  sanitizeToolResultError,
} from "../../app-logger/sanitizers";
import { startSpan, type TBehaviorSpan } from "../../app-logger/span";
import { ConnectorService } from "../../connectors";
import { loadConnectors } from "../../connectors/config";
import { createMcpSamplingRequest, createMcpSamplingResult } from "../../connectors/mcp/sampling";
import type { TMcpElicit, TMcpSampleParams, TMcpSampleResult } from "../../connectors/mcp/types";
import { ConnectorRunRegistry, type TConnectorRunStatus } from "../../connectors/runs";
import { compactConversation } from "../../conversation/compaction";
import {
  attachmentBlock,
  conversationMessages,
  SAttachmentBlock,
  type TConversation,
} from "../../conversation/types";
import type { TAttachmentRef } from "../../messaging/types";
import { EConfigKey, type TConfigRecord } from "../../settings/schema";
import { AGENTS, EAgentName } from "../agents";
import baseInstructions from "../instructions/base-system.xml" with { type: "text" };
import { injectConfig } from "../instructions/inject-config";
import { createPlatformInstructions } from "../instructions/platform";
import { readXmlAndInjectConfig } from "../instructions/read-xml-and-inject-config";
import { emptyUsage, LlmClient, type TLlmModelConfig } from "../llm";
import { aiModels } from "../providers/registry";
import { type TToolExecutionContext, validateToolArguments } from "../tools/define-tool";
import { EModelPurpose } from "../types";
import type { TAgentRunArgs, TAgentRunResult, TAgentStep, TMainAgentRunResult } from "./types";

const SEQUENTIAL: "sequential" = "sequential";
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

  // a plain chat's turn: the plain agent, with Main's root delegation limit
  public async runPlain(
    args: Omit<TAgentRunArgs, "name" | "parentToolCallId">,
  ): Promise<TMainAgentRunResult> {
    let delegationCount = 0;

    return this.run({
      ...args,
      name: EAgentName.Plain,
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
    args: Omit<TAgentRunArgs, "name" | "parentToolCallId" | "onStep">,
  ): Promise<TAgentRunResult> {
    return this.run({
      ...args,
      name: EAgentName.ScheduledTask,
      parentToolCallId: undefined,
      onStep: undefined,
      delegationCount: undefined,
    });
  }

  public async compactConversation(
    state: TConversation,
    settings: TConfigRecord,
    conversationKey: string,
    ownerKey: string,
    platform: TAgentRunArgs["platform"],
    trace: TBehaviorTraceContext,
    events: TAgentRunArgs["events"],
    force: boolean,
    // the model the summary runs on instead of the one the settings resolve to
    selected: TOption<TLlmModelConfig>,
  ) {
    let config = selected;
    if (config === undefined) {
      config = await this.llm.resolveModel(settings, AGENTS[EAgentName.Main].purpose);
    }
    let fallbackConfig = config;
    // a forced compaction that fails on the selected model runs on the provider's default one
    if (force) {
      fallbackConfig = await this.llm.resolveModel(
        { ...settings, [EConfigKey.AiModelPreferences]: "{}" },
        AGENTS[EAgentName.Main].purpose,
      );
    }
    const args = {
      name: EAgentName.Main,
      settings,
      conversationKey,
      ownerKey,
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
    const sessionId = this.llm.createSessionId(config.model.provider, conversationKey);
    const headers = this.llm.sessionHeaders(config.model.provider, sessionId);
    const model = { ...config.model, headers: { ...config.model.headers, ...headers } };
    const fallback = {
      ...fallbackConfig.model,
      headers: { ...fallbackConfig.model.headers, ...headers },
    };
    return compactConversation(state, aiModels, model, fixedTokens, trace, force, fallback);
  }

  private async run(
    args: TAgentRunArgs & { delegationCount: TOption<() => void> },
  ): Promise<TMainAgentRunResult> {
    const agentDefinition = AGENTS[args.name];
    let modelConfig = args.model;
    if (modelConfig === undefined) {
      modelConfig = await this.llm.resolveModel(
        args.settings,
        agentDefinition.purpose,
        args.signal,
      );
    }
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
    const sessionId = this.llm.createSessionId(modelConfig.model.provider, args.conversationKey);

    const toolSpans = new Map<string, TBehaviorSpan>();
    // the started steps, by tool call id; empty without onStep
    const steps = new Map<string, TAgentStep>();
    const toolLabels = new Map(tools.map((tool) => [tool.name, tool.label]));
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
      streamFn: async (model, context, options) => {
        if (iterations >= agentDefinition.maxIterations) {
          return createHardLimitStream(model);
        }

        iterations += 1;
        requestSpan = startSpan(args.trace, "model.request.completed", "agent-harness");
        // NOTE: nothing reads the deltas, so the loop gets the finished message of a retried call
        const stream = createAssistantMessageEventStream();
        stream.end(await this.llm.complete(modelConfig, context, options ?? {}, sessionId));
        return stream;
      },
      getApiKey: (provider) => this.llm.resolveApiKey(provider),
      toolExecution: "parallel",
      prepareNextTurnWithContext: (context) => {
        let nextTools = context.context.tools;
        if (args.connector !== undefined) {
          nextTools = [...args.connector.tools];
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

        if (args.onStep !== undefined) {
          const step: TAgentStep = {
            stepId: event.toolCallId,
            tool: event.toolName,
            label: toolLabels.get(event.toolName) ?? event.toolName,
            detail: stepDetail(event.toolName, event.args),
            state: "started",
            startedAt: Date.now(),
            durationMs: undefined,
          };
          steps.set(event.toolCallId, step);
          args.onStep(step);
        }
      }

      if (event.type === "tool_execution_end") {
        const step = steps.get(event.toolCallId);

        if (step !== undefined) {
          steps.delete(event.toolCallId);
          let state: TAgentStep["state"] = "completed";

          if (event.isError) {
            state = "failed";
          }

          args.onStep?.({ ...step, state, durationMs: Date.now() - step.startedAt });
        }

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
        if (
          (args.name === EAgentName.Main || args.name === EAgentName.Plain) &&
          args.conversationKey !== undefined
        ) {
          const pendingRuns = ConnectorRunRegistry.instance.list(args.conversationKey);
          if (pendingRuns.length > 0) {
            prompt += `\n\nPending connector runs awaiting this user's response:\n${JSON.stringify(pendingRuns)}`;
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
    const instructions = [
      agentDefinition.instructions,
      ...agentDefinition.tools.map((tool) => tool.instructions),
    ];

    if (agentDefinition.base) {
      instructions.unshift(baseInstructions);
    }

    const parts = instructions.map((xml) => readXmlAndInjectConfig(xml, args.settings));

    // NOTE: Bella's persona gets its config placeholders resolved and nothing else, as in the Bella
    // prompt. The plain chats' own text is taken as written: it is no template, so a brace in it
    // cannot break the prompt. With neither persona the prompt has no persona element
    if (args.name === EAgentName.Plain) {
      const personas: string[] = [];

      if (args.settings[EConfigKey.AiPlainChatsUseBellaPersona] === "true") {
        personas.push(injectConfig(args.settings[EConfigKey.AiInstructionsPersona], args.settings));
      }

      if (args.settings[EConfigKey.AiPlainChatsPersona].length > 0) {
        personas.push(args.settings[EConfigKey.AiPlainChatsPersona]);
      }

      if (personas.length > 0) {
        parts.unshift(`<persona>\n${personas.join("\n\n")}\n</persona>`);
      }
    }

    if (args.connector?.connector.instructions !== undefined) {
      parts.push(
        `<connector_instructions>${args.connector.connector.instructions}</connector_instructions>`,
      );
    }

    if (args.connector?.instructions !== undefined) {
      parts.push(
        `<server_reported_instructions>${args.connector.instructions}</server_reported_instructions>`,
      );
    }

    if (args.name === EAgentName.Scheduling) {
      let connectors: Awaited<ReturnType<typeof loadConnectors>> = [];
      try {
        connectors = await loadConnectors(this.requireConnectorChatId(args.ownerKey));
      } catch (error) {
        this.logger.warning(`Connectors unavailable to Scheduling: ${String(error)}`);
      }
      if (connectors.length > 0) {
        const summary = connectors
          .map((connector) => `${connector.id}: ${connector.description}`)
          .join("\n");
        parts.push(`<scheduled_task_connectors>\n${summary}\n</scheduled_task_connectors>`);
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
      conversationKey: args.conversationKey,
      ownerKey: args.ownerKey,
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

    if (agentDefinition.connectors && args.withoutConnectors !== true) {
      tools.push(...(await this.createConnectorDelegationTools(args)));
    }

    if (args.connector !== undefined) {
      tools.push(...args.connector.tools);
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
            model: undefined,
            onStep: undefined,
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

  private async createConnectorDelegationTools(
    args: TAgentRunArgs & { delegationCount: TOption<() => void> },
  ): Promise<AgentTool[]> {
    let connectors: Awaited<ReturnType<typeof loadConnectors>> = [];
    try {
      connectors = await loadConnectors(this.requireConnectorChatId(args.ownerKey));
    } catch (error) {
      this.logger.warning(`Connector delegation disabled: ${String(error)}`);
    }
    if (args.name === EAgentName.Plain) {
      connectors = connectors.filter((connector) => connector.plainChats);
    }
    const connectorSummary = connectors
      .map((connector) => `${connector.id}: ${connector.description}`)
      .join("\n");
    const delegateSchema = obj(
      {
        connectorId: str({
          minLength: 1,
          description: `One configured connector:\n${connectorSummary}`,
        }),
        task: str({ minLength: 1, description: "Focused task for the connector specialist" }),
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
        name: "delegate-connector",
        label: "Delegate connector",
        description: `Run one configured connector specialist. Connectors:\n${connectorSummary}`,
        parameters: delegateSchema,
        executionMode: SEQUENTIAL,
        execute: async (toolCallId, parameters, signal) => {
          const parsed = validateToolArguments(delegateSchema, parameters);
          if (args.name === EAgentName.Main || args.name === EAgentName.Plain) {
            args.delegationCount?.();
          }
          const connector = connectors.find((candidate) => candidate.id === parsed.connectorId);
          if (connector === undefined) {
            throw new Error(`Unknown connector: ${parsed.connectorId}`);
          }
          // credentials belong to the owner, pending runs to the conversation
          const ownerKey = this.requireConnectorChatId(args.ownerKey);
          const conversationKey = this.requireConnectorChatId(args.conversationKey);
          const controller = new AbortController();
          const abort = () => controller.abort();
          signal?.addEventListener("abort", abort, { once: true });
          args.signal?.addEventListener("abort", abort, { once: true });
          let sampleCount = 0;
          let forwardElicitation: TMcpElicit = () => {
            return Promise.reject(new Error("MCP elicitation started before the specialist"));
          };
          try {
            const session = await ConnectorService.instance.open({
              ownerKey,
              conversationKey,
              connectorId: connector.id,
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
                  args.conversationKey,
                  args.trace,
                  toolCallId,
                  sampleCount,
                  requestSignal,
                );
              },
              elicit: (params, requestSignal) => forwardElicitation(params, requestSignal),
            });
            const status = await ConnectorRunRegistry.instance.start({
              chatId: conversationKey,
              connectorId: connector.id,
              inputTimeoutMs: connector.inputTimeoutMs,
              controller,
              close: () => session.close(),
              run: async (runSignal, elicit) => {
                forwardElicitation = elicit;
                const result = await this.run({
                  ...args,
                  name: EAgentName.Connector,
                  prompt: this.createConnectorPrompt(args.prompt, parsed.task, parsed.context),
                  conversation: undefined,
                  parentToolCallId: toolCallId,
                  signal: AbortSignal.any([runSignal, session.signal]),
                  delegationCount: undefined,
                  connector: {
                    connector: session.connector,
                    tools: session.tools,
                    instructions: session.instructions,
                  },
                  model: undefined,
                  onStep: undefined,
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
            return this.connectorStatusResult(status);
          } finally {
            signal?.removeEventListener("abort", abort);
            args.signal?.removeEventListener("abort", abort);
          }
        },
      },
      {
        name: "resume-connector",
        label: "Resume connector",
        description: "Resume a connector run that requested user input",
        parameters: resumeSchema,
        executionMode: SEQUENTIAL,
        execute: async (_toolCallId, parameters, signal) => {
          const parsed = validateToolArguments(resumeSchema, parameters);
          const status = await ConnectorRunRegistry.instance.resume(
            this.requireConnectorChatId(args.conversationKey),
            parsed.runId,
            { action: parsed.action, content: parsed.content },
            signal,
          );
          return this.connectorStatusResult(status);
        },
      },
      {
        name: "cancel-connector",
        label: "Cancel connector",
        description: "Cancel a live connector run owned by this chat",
        parameters: cancelSchema,
        executionMode: SEQUENTIAL,
        execute: async (_toolCallId, parameters) => {
          const parsed = validateToolArguments(cancelSchema, parameters);
          await ConnectorRunRegistry.instance.cancel(
            this.requireConnectorChatId(args.conversationKey),
            parsed.runId,
          );
          return {
            content: [{ type: "text", text: "Connector run cancelled" }],
            details: { status: "cancelled", runId: parsed.runId },
          };
        },
      },
    ];
    if (connectors.length === 0) {
      if (
        args.conversationKey === undefined ||
        ConnectorRunRegistry.instance.list(args.conversationKey).length === 0
      ) {
        return [];
      }
      return tools.slice(1);
    }
    return tools;
  }

  private requireConnectorChatId(chatId: TOption<string>): string {
    if (chatId === undefined) {
      throw new Error("Connector delegation requires a chat owner");
    }
    return chatId;
  }

  private createConnectorPrompt(original: string, task: string, context: string): string {
    return `Original user message:\n${original}\n\nDelegated task:\n${task}\n\nRelevant context:\n${context}`;
  }

  private connectorStatusResult(status: TConnectorRunStatus) {
    const content: [{ type: "text"; text: string }] = [
      { type: "text", text: JSON.stringify(status) },
    ];
    return {
      content,
      details: status,
    };
  }

  private async sampleMcp(
    params: TMcpSampleParams,
    settings: TConfigRecord,
    conversationKey: TAgentRunArgs["conversationKey"],
    trace: TBehaviorTraceContext,
    parentToolCallId: string,
    iteration: number,
    signal: AbortSignal,
  ): Promise<TMcpSampleResult> {
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
    const sessionId = this.llm.createSessionId(modelConfig.model.provider, conversationKey);
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
      agentName: EAgentName.Connector,
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

// NOTE: the argument a step shows of its call, by tool: what a person recognises, never an id.
// web-fetch and the specialist delegate tools have their own rule in stepDetail
const STEP_DETAIL_FIELDS = new Map([
  ["web-search", "query"],
  ["delegate-connector", "connectorId"],
]);

// what a step shows of its call: a fetch's host, a delegation's task, or the field
// STEP_DETAIL_FIELDS names, on one line
export function stepDetail(toolName: string, args: unknown): string {
  if (!isRecord(args)) {
    return "";
  }

  let detail = "";
  let field = STEP_DETAIL_FIELDS.get(toolName);

  if (field === undefined && toolName.startsWith("delegate-")) {
    field = "task";
  }

  if (field !== undefined) {
    const value = args[field];

    if (typeof value === "string") {
      detail = value;
    }
  }

  if (toolName === "web-fetch" && typeof args.url === "string" && URL.canParse(args.url)) {
    detail = new URL(args.url).hostname.replace(/^www\./, "");
  }

  return detail.replace(/\s+/g, " ").trim().slice(0, 120);
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
