import z from "zod";
import {
  MODEL_OLLAMA_GLM_5,
  MODEL_OLLAMA_MINIMAX_M2_7,
  MODEL_OLLAMA_NEMOTRON_3_SUPER,
} from "./services/ai/providers/ollama/models";
import {
  MODEL_OPENROUTER_FREE,
  MODEL_OPENROUTER_GEMINI_3_1_PRO_PREVIEW,
  MODEL_OPENROUTER_GEMINI_3_FLASH_PREVIEW,
  MODEL_OPENROUTER_GPT_5_4_MINI,
  MODEL_OPENROUTER_GPT_5_4_NANO,
} from "./services/ai/providers/openrouter/models";
import { EAiProvider } from "./services/ai/types";

const SProviderModels = z.object({
  toolCheap: z.string(),
  toolAccurate: z.string(),
  general: z.string(),
  chat: z.string(),
  chatAccurate: z.string(),
});

const SConfig = z.object({
  ai: z.object({
    provider: z.enum(EAiProvider),
    providers: z.object({
      ollama: z.object({
        models: SProviderModels,
      }),
      openrouter: z.object({
        models: SProviderModels,
      }),
    }),
  }),
});

type TConfig = z.infer<typeof SConfig>;

export const Config: TConfig = {
  ai: {
    provider: EAiProvider.Ollama,
    providers: {
      ollama: {
        models: {
          toolCheap: MODEL_OLLAMA_NEMOTRON_3_SUPER,
          toolAccurate: MODEL_OLLAMA_MINIMAX_M2_7,
          general: MODEL_OLLAMA_GLM_5,
          chat: MODEL_OLLAMA_MINIMAX_M2_7,
          chatAccurate: MODEL_OLLAMA_MINIMAX_M2_7,
        },
      },
      openrouter: {
        models: {
          toolCheap: MODEL_OPENROUTER_GPT_5_4_NANO,
          toolAccurate: MODEL_OPENROUTER_GEMINI_3_FLASH_PREVIEW,
          general: MODEL_OPENROUTER_FREE,
          chat: MODEL_OPENROUTER_GPT_5_4_MINI,
          chatAccurate: MODEL_OPENROUTER_GEMINI_3_1_PRO_PREVIEW,
        },
      },
    },
  },
};
