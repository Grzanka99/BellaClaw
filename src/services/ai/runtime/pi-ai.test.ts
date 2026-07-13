import { afterEach, describe, expect, test } from "bun:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { DefaultConfigRecord, EConfigKey } from "../../settings/schema";
import { aiModels, getAiModel } from "../providers/registry";
import { EAiProvider, EModelPurpose, ERole } from "../types";
import { buildPiContext, requestAssistantTurn } from "./pi-ai";
import type { TRequestAssistantTurnArgs } from "./types";

const ORIGINAL_OPENROUTER_API_KEY = Bun.env.OPENROUTER_API_KEY;

afterEach(() => {
  if (ORIGINAL_OPENROUTER_API_KEY === undefined) {
    delete Bun.env.OPENROUTER_API_KEY;
  } else {
    Bun.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER_API_KEY;
  }
  aiModels.setProvider(openrouterProvider());
});

function createRequestArgs(conversation: Message[]): TRequestAssistantTurnArgs {
  return {
    conversation,
    history: [
      { role: ERole.System, content: "task system" },
      { role: ERole.User, content: "stored user" },
      { role: ERole.Assistant, content: "stored assistant" },
    ],
    user: {
      id: "user-1",
      username: "username",
      displayName: "Display Name",
    },
    currentTimeContext: "current time",
    tools: [
      {
        definition: {
          name: "lookup",
          description: "Look something up",
          parameters: { type: "object", properties: {} },
        },
        instructions: "lookup instructions",
      },
    ],
    purpose: EModelPurpose.Chat,
    settings: {
      ...DefaultConfigRecord,
      [EConfigKey.AiProvider]: EAiProvider.Openrouter,
    },
    trace: {
      turnId: "turn-1",
      chatId: "chat-1",
      platform: "discord",
    },
  };
}

describe("Pi AI request boundary", () => {
  test("builds the system prompt in approved order and keeps system history out of messages", () => {
    const canonicalAssistant = fauxAssistantMessage("runtime assistant");
    const conversation: Message[] = [
      { role: "user", content: "current user", timestamp: 1 },
      canonicalAssistant,
    ];
    const args = createRequestArgs(conversation);
    const model = getAiModel(EAiProvider.Openrouter, EModelPurpose.Chat);

    const context = buildPiContext(args, model, "base system");

    expect(context.systemPrompt).toBe(
      [
        "base system",
        "task system",
        "Current user context - always use this user_id for tool calls:\n- user_id: user-1\n- username: username\n- displayName: Display Name",
        "current time",
        "lookup instructions",
      ].join("\n\n"),
    );
    expect(context.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(
      context.messages.some(
        (message) => message.role === "user" && message.content === "task system",
      ),
    ).toBe(false);
    expect(context.messages[3]).toBe(canonicalAssistant);
    expect(context.tools).toEqual(args.tools.map((tool) => tool.definition));
  });

  test("passes explicit auth and trace session metadata and returns the full Pi message", async () => {
    Bun.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const faux = fauxProvider({
      provider: EAiProvider.Openrouter,
      models: [{ id: "openai/gpt-5.4-mini", reasoning: true }],
    });
    const thinking = fauxThinking("private reasoning");
    thinking.thinkingSignature = "thinking-signature";
    const toolCall = fauxToolCall("lookup", { query: "value" }, { id: "call-1" });
    toolCall.thoughtSignature = "thought-signature";
    const response = fauxAssistantMessage([thinking, toolCall, fauxText("visible response")], {
      stopReason: "toolUse",
      responseId: "response-1",
    });
    let capturedApiKey: string | undefined;
    let capturedReasoning: string | undefined;
    let capturedSessionId: string | undefined;
    let capturedSystemPrompt: string | undefined;
    faux.setResponses([
      (context, options) => {
        capturedApiKey = options?.apiKey;
        if (
          options !== undefined &&
          "reasoning" in options &&
          typeof options.reasoning === "string"
        ) {
          capturedReasoning = options.reasoning;
        }
        capturedSessionId = options?.sessionId;
        capturedSystemPrompt = context.systemPrompt;
        return response;
      },
    ]);
    aiModels.setProvider(faux.provider);

    const result = await requestAssistantTurn(
      createRequestArgs([{ role: "user", content: "current user", timestamp: 1 }]),
    );

    expect(capturedApiKey).toBe("test-openrouter-key");
    expect(capturedReasoning).toBe("medium");
    expect(capturedSessionId).toBe("turn-1");
    expect(capturedSystemPrompt).toContain("lookup instructions");
    expect(result.stopReason).toBe("toolUse");
    expect(result.responseId).toBe("response-1");
    expect(result.content).toEqual(response.content);
  });

  test("returns error and aborted assistant messages without flattening them", async () => {
    Bun.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const faux = fauxProvider({
      provider: EAiProvider.Openrouter,
      models: [{ id: "openai/gpt-5.4-mini" }],
    });
    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "provider failed",
      }),
      fauxAssistantMessage([], {
        stopReason: "aborted",
        errorMessage: "request aborted",
      }),
    ]);
    aiModels.setProvider(faux.provider);
    const args = createRequestArgs([{ role: "user", content: "current user", timestamp: 1 }]);

    const failed = await requestAssistantTurn(args);
    const aborted = await requestAssistantTurn(args);

    expect(failed.stopReason).toBe("error");
    expect(failed.errorMessage).toBe("provider failed");
    expect(aborted.stopReason).toBe("aborted");
    expect(aborted.errorMessage).toBe("request aborted");
  });

  test("rejects an invalid stored provider before making a request", async () => {
    const args = createRequestArgs([{ role: "user", content: "current user", timestamp: 1 }]);
    args.settings[EConfigKey.AiProvider] = "invalid-provider";

    await expect(requestAssistantTurn(args)).rejects.toThrow("Unknown AI provider");
  });
});
