import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AppLogger, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import {
  type Context,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Model,
} from "@earendil-works/pi-ai";
import { EMessagePlatform } from "../../messaging/types";
import { DefaultConfigRecord, EConfigKey } from "../../settings/schema";
import { aiModels } from "../providers/registry";
import { EAiProvider, EModelPurpose, ERole, type THistoryItem } from "../types";
import { AgentHarness, EAgentName, isSerializedToolCall } from ".";

const OPENROUTER_MODELS = [
  "openai/gpt-5.4-nano",
  "google/gemini-3-flash-preview",
  "openrouter/free",
  "openai/gpt-5.4-mini",
  "google/gemini-3.1-pro-preview",
].map((id) => ({ id, reasoning: true }));

describe("AgentHarness", () => {
  const previousApiKey = Bun.env.OPENROUTER_API_KEY;
  const previousOpenCodeApiKey = Bun.env.OPENCODE_API_KEY;
  const faux = fauxProvider({
    provider: EAiProvider.Openrouter,
    models: OPENROUTER_MODELS,
  });

  beforeEach(() => {
    Bun.env.OPENROUTER_API_KEY = "test-key";
    aiModels.setProvider(faux.provider);
  });

  afterEach(() => {
    if (previousApiKey === undefined) {
      delete Bun.env.OPENROUTER_API_KEY;
    } else {
      Bun.env.OPENROUTER_API_KEY = previousApiKey;
    }

    if (previousOpenCodeApiKey === undefined) {
      delete Bun.env.OPENCODE_API_KEY;
    } else {
      Bun.env.OPENCODE_API_KEY = previousOpenCodeApiKey;
    }
  });

  test("uses the configured registry model and a fresh sessionless transcript for every run", async () => {
    const contexts: Array<{ messages: Context["messages"]; toolNames: string[] }> = [];
    const models: Model<string>[] = [];
    const sessionIds: Array<string | undefined> = [];
    faux.setResponses([
      (context, options, _state, model) => {
        contexts.push({
          messages: structuredClone(context.messages),
          toolNames: context.tools?.map((tool) => tool.name) ?? [],
        });
        models.push(model);
        sessionIds.push(options?.sessionId);
        return fauxAssistantMessage("first");
      },
      (context, options, _state, model) => {
        contexts.push({
          messages: structuredClone(context.messages),
          toolNames: context.tools?.map((tool) => tool.name) ?? [],
        });
        models.push(model);
        sessionIds.push(options?.sessionId);
        return fauxAssistantMessage("second");
      },
    ]);

    const settings = {
      ...DefaultConfigRecord,
      [EConfigKey.AiProvider]: EAiProvider.Openrouter,
    };
    const harness = AgentHarness.instance;
    const first = await harness.runMain({
      prompt: "first prompt",
      history: [{ role: ERole.User, content: "stored history" }],
      chatId: "discord:1",
      settings,
      currentTimeContext: "time one",
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: undefined,
    });
    settings[EConfigKey.AiInstructionsTimezone] = "Asia/Tokyo";
    settings[EConfigKey.AiModelPreferences] = JSON.stringify({
      [EAiProvider.Openrouter]: {
        [EModelPurpose.Main]: { model: "openai/gpt-5.4-mini", effort: "high" },
      },
    });
    const second = await harness.runMain({
      prompt: "second prompt",
      history: [],
      chatId: "discord:1",
      settings,
      currentTimeContext: "time two",
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: undefined,
    });

    expect(first.text).toBe("first");
    expect(second.text).toBe("second");
    expect(models.map((model) => model.id)).toEqual([
      "google/gemini-3.1-pro-preview",
      "openai/gpt-5.4-mini",
    ]);
    expect(sessionIds).toEqual([undefined, undefined]);
    expect(contexts[0]?.messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(contexts[1]?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(JSON.stringify(contexts[1])).not.toContain("first prompt");
    expect(JSON.stringify(contexts[1])).not.toContain("stored history");
  });

  test("sends a stable OpenCode session header for each conversation", async () => {
    Bun.env.OPENCODE_API_KEY = "opencode-test-key";
    const sessionIds: Array<string | undefined> = [];
    const sessionHeaders: Array<string | null | undefined> = [];
    const opencode = fauxProvider({
      provider: EAiProvider.OpencodeGo,
      models: [
        { id: "grok-4.6", reasoning: true },
        { id: "deepseek-v4-pro", reasoning: true },
      ],
    });
    opencode.setResponses([
      (_context, options) => {
        sessionIds.push(options?.sessionId);
        sessionHeaders.push(options?.headers?.["x-opencode-session"]);
        return fauxAssistantMessage(fauxToolCall("missing-tool", {}, { id: "missing" }));
      },
      (_context, options) => {
        sessionIds.push(options?.sessionId);
        sessionHeaders.push(options?.headers?.["x-opencode-session"]);
        return fauxAssistantMessage("conversation final");
      },
      (_context, options) => {
        sessionIds.push(options?.sessionId);
        sessionHeaders.push(options?.headers?.["x-opencode-session"]);
        return fauxAssistantMessage("same conversation final");
      },
      (_context, options) => {
        sessionIds.push(options?.sessionId);
        sessionHeaders.push(options?.headers?.["x-opencode-session"]);
        return fauxAssistantMessage("other conversation final");
      },
      (_context, options) => {
        sessionIds.push(options?.sessionId);
        sessionHeaders.push(options?.headers?.["x-opencode-session"]);
        return fauxAssistantMessage("direct final");
      },
    ]);
    aiModels.setProvider(opencode.provider);
    const settings = {
      ...DefaultConfigRecord,
      [EConfigKey.AiProvider]: EAiProvider.OpencodeGo,
    };

    const conversation = await AgentHarness.instance.runMain({
      prompt: "hello",
      history: [],
      chatId: "discord:1",
      settings,
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: undefined,
    });
    const sameConversation = await AgentHarness.instance.runMain({
      prompt: "hello again",
      history: [],
      chatId: "discord:1",
      settings,
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: undefined,
    });
    const otherConversation = await AgentHarness.instance.runMain({
      prompt: "hello elsewhere",
      history: [],
      chatId: "discord:2",
      settings,
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: undefined,
    });
    const direct = await AgentHarness.instance.completeText({
      prompt: "hello",
      instructions: "Reply directly",
      settings,
      purpose: EModelPurpose.Utility,
      trace: undefined,
    });

    expect(conversation.text).toBe("conversation final");
    expect(sameConversation.text).toBe("same conversation final");
    expect(otherConversation.text).toBe("other conversation final");
    expect(direct).toBe("direct final");
    const expectedConversationId = new Bun.CryptoHasher("sha256", "opencode-test-key")
      .update("discord:discord:1")
      .digest("hex");

    expect(sessionIds[0]).toBe(expectedConversationId);
    expect(sessionIds[0]).toBe(sessionIds[1]);
    expect(sessionIds[0]).toBe(sessionIds[2]);
    expect(sessionIds[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionIds[3]).not.toBe(sessionIds[0]);
    expect(sessionIds[4]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionIds[4]).not.toBe(sessionIds[0]);
    expect(sessionHeaders).toEqual(sessionIds);
  });

  test("rejects an OpenCode conversation before streaming when its API key is missing", async () => {
    delete Bun.env.OPENCODE_API_KEY;
    const opencode = fauxProvider({
      provider: EAiProvider.OpencodeGo,
      models: [{ id: "grok-4.6", reasoning: true }],
    });
    opencode.setResponses([fauxAssistantMessage("must not stream")]);
    aiModels.setProvider(opencode.provider);

    await expect(
      AgentHarness.instance.runMain({
        prompt: "hello",
        history: [],
        chatId: "discord:1",
        settings: {
          ...DefaultConfigRecord,
          [EConfigKey.AiProvider]: EAiProvider.OpencodeGo,
        },
        currentTimeContext: undefined,
        platform: EMessagePlatform.Discord,
        trace: undefined,
        signal: undefined,
      }),
    ).rejects.toThrow("Missing required environment variable OPENCODE_API_KEY");
    expect(opencode.state.callCount).toBe(0);
  });

  test("retains the Signal styled-text contract in the assembled production prompt", async () => {
    let systemPrompt = "";
    faux.setResponses([
      (context) => {
        systemPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage("Signal reply");
      },
    ]);

    await AgentHarness.instance.runMain({
      prompt: "hello",
      history: [],
      chatId: "signal:+100",
      settings: {
        ...DefaultConfigRecord,
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      },
      currentTimeContext: undefined,
      platform: EMessagePlatform.Signal,
      trace: undefined,
      signal: undefined,
    });

    expect(systemPrompt).toContain("*italic*, **bold**, `monospace`, ~strikethrough~");
    expect(systemPrompt).toContain("Never use headings, tables, blockquotes, embeds");
  });

  test("requires memory delegation for answers depending on personal user facts", async () => {
    let systemPrompt = "";
    let memoryDescription = "";
    faux.setResponses([
      (context) => {
        systemPrompt = context.systemPrompt ?? "";
        memoryDescription =
          context.tools?.find((tool) => tool.name === "delegate-memory")?.description ?? "";
        return fauxAssistantMessage("Memory-aware reply");
      },
    ]);

    await AgentHarness.instance.runMain({
      prompt: "What is my favorite restaurant?",
      history: [],
      chatId: "discord:1",
      settings: {
        ...DefaultConfigRecord,
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      },
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: undefined,
    });

    expect(systemPrompt).toContain("Delegate memory lookup");
    expect(systemPrompt).toContain("Invoke registered tools through the native tool mechanism");
    expect(memoryDescription).toBe(
      "Required for personal user facts and forget requests. Run the Memory specialist to retrieve or forget the relevant facts.",
    );
  });

  test("returns undefined for blank and provider-error final messages", async () => {
    faux.setResponses([
      fauxAssistantMessage("   "),
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider failed" }),
    ]);
    const args = {
      prompt: "hello",
      history: [],
      chatId: "discord:1",
      settings: {
        ...DefaultConfigRecord,
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      },
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: undefined,
    };

    expect((await AgentHarness.instance.runMain(args)).text).toBeUndefined();
    const failed = await AgentHarness.instance.runMain(args);
    expect(failed.text).toBeUndefined();
    expect(failed.stopReason).toBe("error");
  });

  test("does not start a provider stream for a pre-cancelled run", async () => {
    faux.setResponses([fauxAssistantMessage("must not run")]);
    const controller = new AbortController();
    controller.abort();

    const result = await AgentHarness.instance.runMain({
      prompt: "cancelled",
      history: [],
      chatId: "discord:1",
      settings: {
        ...DefaultConfigRecord,
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      },
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: controller.signal,
    });

    expect(result.text).toBeUndefined();
    expect(result.stopReason).toBe("aborted");
    expect(faux.getPendingResponseCount()).toBe(1);
  });

  test("forces a final answer after the 30-root and 12-specialist iteration budgets", async () => {
    const rootResponses = Array.from({ length: 29 }, (_, index) =>
      fauxAssistantMessage(fauxToolCall("missing-tool", { index }, { id: `root-${index}` })),
    );
    faux.setResponses([...rootResponses, fauxAssistantMessage("root final")]);

    const root = await AgentHarness.instance.runMain({
      prompt: "loop",
      history: [],
      chatId: "discord:1",
      settings: {
        ...DefaultConfigRecord,
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      },
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: undefined,
    });

    expect(root.text).toBe("root final");
    expect(root.iterations).toBe(30);
    expect(root.stopReason).toBe("iteration-limit");

    const specialistResponses = Array.from({ length: 11 }, (_, index) =>
      fauxAssistantMessage(fauxToolCall("missing-tool", { index }, { id: `specialist-${index}` })),
    );
    faux.setResponses([...specialistResponses, fauxAssistantMessage("specialist final")]);
    const run = AgentHarness.instance as unknown as {
      run(args: {
        name: EAgentName;
        purpose: EModelPurpose;
        prompt: string;
        chatId: string;
        settings: typeof DefaultConfigRecord;
        currentTimeContext: undefined;
        platform: EMessagePlatform;
        trace: undefined;
        history: THistoryItem[];
        maxIterations: number;
        parentToolCallId: undefined;
        signal: undefined;
        delegationCount: undefined;
      }): Promise<{ text?: string; iterations: number }>;
    };
    const specialist = await run.run({
      name: EAgentName.Memory,
      purpose: EModelPurpose.Specialist,
      prompt: "loop",
      chatId: "discord:1",
      settings: {
        ...DefaultConfigRecord,
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      },
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: undefined,
      history: [],
      maxIterations: 12,
      parentToolCallId: undefined,
      signal: undefined,
      delegationCount: undefined,
    });

    expect(specialist.text).toBe("specialist final");
    expect(specialist.iterations).toBe(12);
  });

  test("hard-stops when the single forced-final attempt still calls a tool", async () => {
    const responses = Array.from({ length: 30 }, (_, index) =>
      fauxAssistantMessage(fauxToolCall("missing-tool", { index }, { id: `refusal-${index}` })),
    );
    faux.setResponses([...responses, fauxAssistantMessage("must not run")]);
    const callsBefore = faux.state.callCount;

    const result = await AgentHarness.instance.runMain({
      prompt: "refuse final",
      history: [],
      chatId: "discord:1",
      settings: {
        ...DefaultConfigRecord,
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      },
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: undefined,
    });

    expect(result.text).toBeUndefined();
    expect(result.iterations).toBe(30);
    expect(result.stopReason).toBe("forced-finalization-failed");
    expect(faux.state.callCount - callsBefore).toBe(30);
  });

  test("clears nonterminal text when a later terminal provider error occurs", async () => {
    faux.setResponses([
      fauxAssistantMessage([
        { type: "text", text: "stale draft" },
        fauxToolCall("missing-tool", { step: 1 }),
      ]),
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider failed" }),
    ]);

    const result = await AgentHarness.instance.runMain({
      prompt: "fail after tool",
      history: [],
      chatId: "discord:1",
      settings: {
        ...DefaultConfigRecord,
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      },
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: undefined,
    });

    expect(result.text).toBeUndefined();
    expect(result.stopReason).toBe("error");
  });

  test("actively cancels an in-flight provider run and clears output", async () => {
    const controller = new AbortController();
    let started: () => void = () => undefined;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    faux.setResponses([
      async (_context, options) => {
        started();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return fauxAssistantMessage("stale after abort");
      },
    ]);

    const pending = AgentHarness.instance.runMain({
      prompt: "cancel active",
      history: [],
      chatId: "discord:1",
      settings: {
        ...DefaultConfigRecord,
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      },
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: controller.signal,
    });
    await providerStarted;
    controller.abort();
    const result = await pending;

    expect(result.text).toBeUndefined();
    expect(result.stopReason).toBe("aborted");
  });

  test("stops repeated identical tool batches and requests a tool-free final answer", async () => {
    const toolNames: string[][] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate-memory", { task: "same" }, { id: "one" })),
      fauxAssistantMessage("memory one"),
      fauxAssistantMessage(fauxToolCall("delegate-memory", { task: "same" }, { id: "two" })),
      fauxAssistantMessage("memory two"),
      (context) => {
        toolNames.push(context.tools?.map((tool) => tool.name) ?? []);
        return fauxAssistantMessage("forced final");
      },
    ]);

    const result = await AgentHarness.instance.runMain({
      prompt: "repeat",
      history: [],
      chatId: "discord:1",
      settings: {
        ...DefaultConfigRecord,
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      },
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: undefined,
    });

    expect(result.text).toBe("forced final");
    expect(toolNames[0]).toEqual([]);
  });

  test("treats reordered nested argument keys as the same repeated call", async () => {
    const toolNames: string[][] = [];
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("missing-tool", {
          outer: { alpha: 1, beta: { first: true, second: false } },
        }),
      ),
      fauxAssistantMessage(
        fauxToolCall("missing-tool", {
          outer: { beta: { second: false, first: true }, alpha: 1 },
        }),
      ),
      (context) => {
        toolNames.push(context.tools?.map((tool) => tool.name) ?? []);
        return fauxAssistantMessage("forced after canonical repeat");
      },
    ]);

    const result = await AgentHarness.instance.runMain({
      prompt: "repeat nested",
      history: [],
      chatId: "discord:1",
      settings: {
        ...DefaultConfigRecord,
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      },
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: undefined,
    });

    expect(result.text).toBe("forced after canonical repeat");
    expect(toolNames[0]).toEqual([]);
  });

  test("runs independent memory and settings delegations concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const specialistResponse = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);

      if (active === 2) {
        release();
      }

      await bothStarted;
      active -= 1;
      return fauxAssistantMessage("specialist result");
    };
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("delegate-memory", { task: "memory" }, { id: "memory-call" }),
        fauxToolCall("delegate-settings", { task: "settings" }, { id: "settings-call" }),
      ]),
      specialistResponse,
      specialistResponse,
      fauxAssistantMessage("combined"),
    ]);

    const result = await AgentHarness.instance.runMain({
      prompt: "Use memory and settings",
      history: [],
      chatId: "discord:1",
      settings: {
        ...DefaultConfigRecord,
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      },
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: undefined,
    });

    expect(result.text).toBe("combined");
    expect(maxActive).toBe(2);
  });

  test("passes a Memory result explicitly into a later Scheduling delegation", async () => {
    let schedulingTask = "";
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("delegate-memory", { task: "Find the agreed day" }, { id: "memory-call" }),
      ),
      fauxAssistantMessage("The agreed day is Friday."),
      fauxAssistantMessage(
        fauxToolCall(
          "delegate-scheduling",
          { task: "Schedule the reminder for Friday, the day returned by Memory." },
          { id: "schedule-call" },
        ),
      ),
      (context) => {
        schedulingTask = JSON.stringify(context.messages);

        return fauxAssistantMessage("Scheduled Friday");
      },
      fauxAssistantMessage("Done"),
    ]);

    const result = await AgentHarness.instance.runMain({
      prompt: "Recall the date, then schedule it",
      history: [],
      chatId: "discord:1",
      settings: {
        ...DefaultConfigRecord,
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      },
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: undefined,
      signal: undefined,
    });

    expect(result.text).toBe("Done");
    expect(schedulingTask).toContain("Delegated task:");
    expect(schedulingTask).toContain("Friday");
    expect(schedulingTask).toContain("returned by Memory");
  });

  test("enforces 30 delegations, specialist nonblank results, and depth one", async () => {
    const harness = AgentHarness.instance as unknown as {
      createDelegationTools(args: {
        name: EAgentName;
        purpose: EModelPurpose;
        prompt: string;
        chatId: string;
        settings: typeof DefaultConfigRecord;
        currentTimeContext: undefined;
        platform: EMessagePlatform;
        trace: TBehaviorTraceContext;
        history: THistoryItem[];
        maxIterations: number;
        parentToolCallId: TOption<string>;
        signal: TOption<AbortSignal>;
        delegationCount: TOption<() => void>;
      }): Array<{
        name: string;
        executionMode: string;
        execute(id: string, args: unknown): Promise<unknown>;
      }>;
      run: ReturnType<typeof mock>;
    };
    const originalRun = harness.run;
    harness.run = mock(async () => ({
      text: "specialist result",
      iterations: 1,
      toolCallCount: 0,
      stopReason: "completed",
    }));
    let count = 0;
    const base = {
      name: EAgentName.Main,
      purpose: EModelPurpose.Main,
      prompt: "original",
      chatId: "discord:1",
      settings: DefaultConfigRecord,
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace: { turnId: "turn", chatId: "discord:1", platform: EMessagePlatform.Discord },
      history: [],
      maxIterations: 30,
      parentToolCallId: undefined,
      signal: undefined,
      delegationCount: () => {
        count += 1;
        if (count > 30) {
          throw new Error("Root delegation limit reached");
        }
      },
    };
    const tools = harness.createDelegationTools(base);
    const memory = tools.find((tool) => tool.name === "delegate-memory");
    const scheduling = tools.find((tool) => tool.name === "delegate-scheduling");

    expect(memory?.executionMode).toBe("parallel");
    expect(scheduling?.executionMode).toBe("sequential");
    for (let index = 0; index < 30; index += 1) {
      await memory?.execute(`call-${index}`, { task: "remember" });
    }
    expect(memory?.execute("call-31", { task: "remember" })).rejects.toThrow(
      "Root delegation limit reached",
    );
    expect(harness.run).toHaveBeenCalledWith(
      expect.objectContaining({
        name: EAgentName.Memory,
        maxIterations: 12,
        history: undefined,
        parentToolCallId: "call-0",
        delegationCount: undefined,
      }),
    );

    const specialistTools = harness.createDelegationTools({
      ...base,
      name: EAgentName.Memory,
      delegationCount: undefined,
    });
    expect(specialistTools[0]?.execute("nested", { task: "no" })).rejects.toThrow(
      "Specialists cannot delegate",
    );

    harness.run = mock(async () => ({
      text: " ",
      iterations: 1,
      toolCallCount: 0,
      stopReason: "completed",
    }));
    const blankTool = harness.createDelegationTools({
      ...base,
      delegationCount: () => undefined,
    })[0];
    expect(blankTool?.execute("blank", { task: "remember" })).rejects.toThrow(
      "specialist returned no final response",
    );
    harness.run = originalRun;
  });

  test("persists agent hierarchy, tool details, and lifecycle durations", async () => {
    const appLogger = new AppLogger({ dbPath: ":memory:", stdout: () => undefined });
    (AppLogger as unknown as { _instance: AppLogger })._instance = appLogger;
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("delegate-memory", { task: "Recall project alpha" }, { id: "delegate-1" }),
      ),
      fauxAssistantMessage("Project alpha used TypeBox."),
      fauxAssistantMessage("Root final"),
      fauxAssistantMessage("direct final"),
    ]);
    const trace = {
      turnId: "turn-hierarchy",
      chatId: "discord:1",
      platform: EMessagePlatform.Discord,
    };
    const settings = {
      ...DefaultConfigRecord,
      [EConfigKey.AiProvider]: EAiProvider.Openrouter,
    };

    await AgentHarness.instance.runMain({
      prompt: "What did project alpha use?",
      history: [],
      chatId: "discord:1",
      settings,
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace,
      signal: undefined,
    });
    await AgentHarness.instance.completeText({
      prompt: "Reply directly",
      instructions: "Reply directly",
      settings,
      purpose: EModelPurpose.Utility,
      trace,
    });
    await appLogger.flush();
    const events = await appLogger.findByTurnId(trace.turnId);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "agent.completed",
          durationMs: expect.any(Number),
          metadata: expect.objectContaining({
            agentName: EAgentName.Memory,
            parentToolCallId: "delegate-1",
          }),
        }),
        expect.objectContaining({
          event: "tool.call.completed",
          toolName: "delegate-memory",
          durationMs: expect.any(Number),
          metadata: expect.objectContaining({
            toolCallId: "delegate-1",
            responsePreview: "Project alpha used TypeBox.",
          }),
        }),
        expect.objectContaining({
          event: "direct-completion.completed",
          durationMs: expect.any(Number),
          success: true,
        }),
      ]),
    );

    await appLogger.close();
    (AppLogger as unknown as { _instance: undefined })._instance = undefined;
  });

  test("persists extracted tool errors and failed direct-completion lifecycle duration", async () => {
    const appLogger = new AppLogger({ dbPath: ":memory:", stdout: () => undefined });
    (AppLogger as unknown as { _instance: AppLogger })._instance = appLogger;
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("delegate-memory", { task: "Return nothing" }, { id: "failed-delegate" }),
      ),
      fauxAssistantMessage("   "),
      fauxAssistantMessage("Recovered root response"),
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "direct provider failed",
      }),
    ]);
    const trace = {
      turnId: "turn-failures",
      chatId: "discord:1",
      platform: EMessagePlatform.Discord,
    };
    const settings = {
      ...DefaultConfigRecord,
      [EConfigKey.AiProvider]: EAiProvider.Openrouter,
    };

    await AgentHarness.instance.runMain({
      prompt: "Test tool failure",
      history: [],
      chatId: "discord:1",
      settings,
      currentTimeContext: undefined,
      platform: EMessagePlatform.Discord,
      trace,
      signal: undefined,
    });
    const direct = await AgentHarness.instance.completeText({
      prompt: "Fail directly",
      instructions: "Fail directly",
      settings,
      purpose: EModelPurpose.Utility,
      trace,
    });
    await appLogger.flush();
    const events = await appLogger.findByTurnId(trace.turnId);
    const failedTool = events.find(
      (event) => event.event === "tool.call.completed" && event.toolName === "delegate-memory",
    );
    const failedDirect = events.find((event) => event.event === "direct-completion.completed");

    expect(direct).toBeUndefined();
    expect(failedTool).toMatchObject({
      success: false,
      durationMs: expect.any(Number),
      error: "memory specialist returned no final response",
      metadata: expect.objectContaining({ toolCallId: "failed-delegate" }),
    });
    expect(failedDirect).toMatchObject({
      success: false,
      durationMs: expect.any(Number),
      error: "direct provider failed",
      metadata: expect.objectContaining({ stopReason: "error", responseChars: 0 }),
    });

    await appLogger.close();
    (AppLogger as unknown as { _instance: undefined })._instance = undefined;
  });
});

describe("isSerializedToolCall", () => {
  const tools = [{ name: "search-memory" }, { name: "web-search" }];

  test("detects a serialized call, fenced or bare", () => {
    expect(isSerializedToolCall('{"name":"search-memory","arguments":{"query":"x"}}', tools)).toBe(
      true,
    );
    expect(
      isSerializedToolCall(
        '```json\n{"name":"search-memory","arguments":{"query":"x"}}\n```',
        tools,
      ),
    ).toBe(true);
  });

  test("keeps a fenced code sample that merely mentions a tool name", () => {
    expect(isSerializedToolCall('```ts\nconst name = "search-memory";\n```', tools)).toBe(false);
  });

  test("keeps JSON that documents tools without calling one", () => {
    expect(isSerializedToolCall('{"tools":["search-memory","web-search"]}', tools)).toBe(false);
  });
});
