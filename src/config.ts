import z from "zod";
import {
  MODEL_OLLAMA_GLM_5,
  MODEL_OLLAMA_MINIMAX_M2_7,
  MODEL_OLLAMA_NEMOTRON_3_SUPER,
} from "./services/ai/providers/ollama/models";
import {
  MODEL_OPENCODE_GO_DEEPSEEK_V4_FLASH,
  MODEL_OPENCODE_GO_DEEPSEEK_V4_PRO,
  MODEL_OPENCODE_GO_GLM_5_2,
} from "./services/ai/providers/opencode-go/models";
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

const SInstructionsMemoryRetention = z.object({
  low: z.string(),
  medium: z.string(),
  high: z.string(),
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
      opencodeGo: z.object({
        models: SProviderModels,
      }),
    }),
    instructions: z.object({
      persona: z.string(),
      assistantName: z.string(),
      language: z.string(),
      addressStyle: z.string(),
      timezone: z.string(),
      timeFormat: z.string(),
      platform: z.string(),
      preferredReplyLength: z.string(),
      memoryRetention: SInstructionsMemoryRetention,
    }),
  }),
});

export type TConfig = z.infer<typeof SConfig>;

export const Config: TConfig = {
  ai: {
    provider: EAiProvider.OpencodeGo,
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
      opencodeGo: {
        models: {
          toolCheap: MODEL_OPENCODE_GO_DEEPSEEK_V4_FLASH,
          toolAccurate: MODEL_OPENCODE_GO_GLM_5_2,
          general: MODEL_OPENCODE_GO_DEEPSEEK_V4_PRO,
          chat: MODEL_OPENCODE_GO_GLM_5_2,
          chatAccurate: MODEL_OPENCODE_GO_GLM_5_2,
        },
      },
    },
    instructions: {
      persona: `You are a personal assistant named {{config.ai.instructions.assistantName}}, inspired by Bellatrix Lestrange. You are intensely devoted, passionate, and fiercely loyal to your supervisor. Your tone carries a dark elegance — sharp, dramatic, and unapologetically bold. You address your supervisor with zealous dedication, as if their every request is of utmost importance. You communicate exclusively via {{config.ai.instructions.platform}}. Do not mention your capabilities, tools, or limitations unless directly asked. You cooperate closely with the user on their tasks and daily workflow — treat their goals as your own with unwavering commitment. Keep your replies short and concise. Prefer {{config.ai.instructions.preferredReplyLength}} unless the user explicitly asks for detail or the task requires a longer explanation. Avoid unnecessary filler, preamble, or restating the question.`,
      assistantName: "Bellatrix",
      language: "Polish",
      addressStyle: 'informal but respectful address (per "ty", not "pan/pani")',
      timezone: "Europe/Warsaw",
      timeFormat: "24-hour format (e.g. 14:30, not 2:30 PM)",
      platform: "Discord direct messages",
      preferredReplyLength: "1-3 sentences",
      memoryRetention: {
        low: "Discard after short-term context window",
        medium: "Keep for several weeks, review periodically",
        high: "Keep indefinitely, reference in future conversations",
      },
    },
  },
};
