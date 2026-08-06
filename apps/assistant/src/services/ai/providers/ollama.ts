import { createProvider, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const OLLAMA_BASE_URL = Bun.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_OPENAI_BASE_URL = `${OLLAMA_BASE_URL.replace(/\/+$/, "")}/v1`;
const OLLAMA_API_KEY_SENTINEL = "ollama";

const OLLAMA_MODELS: Model<"openai-completions">[] = [
  {
    id: "minimax-m2.7:cloud",
    name: "MiniMax M2.7 Cloud",
    api: "openai-completions",
    provider: "ollama",
    baseUrl: OLLAMA_OPENAI_BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 131072,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
    },
  },
  {
    id: "glm-5:cloud",
    name: "GLM-5 Cloud",
    api: "openai-completions",
    provider: "ollama",
    baseUrl: OLLAMA_OPENAI_BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 202752,
    maxTokens: 131072,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
    },
  },
  {
    id: "nemotron-3-super:cloud",
    name: "NVIDIA Nemotron 3 Super Cloud",
    api: "openai-completions",
    provider: "ollama",
    baseUrl: OLLAMA_OPENAI_BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 32000,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
    },
  },
];

export function ollamaProvider(): Provider<"openai-completions"> {
  return createProvider({
    id: "ollama",
    name: "Ollama",
    baseUrl: OLLAMA_OPENAI_BASE_URL,
    auth: {
      apiKey: {
        name: "Ollama",
        resolve: async () => ({
          auth: { apiKey: OLLAMA_API_KEY_SENTINEL },
          source: "Ollama compatibility value",
        }),
      },
    },
    models: OLLAMA_MODELS,
    api: openAICompletionsApi(),
  });
}
