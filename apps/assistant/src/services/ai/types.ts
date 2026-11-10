import { z } from "zod";

export enum EAiProvider {
  OpenaiCodex = "openai-codex",
  Openrouter = "openrouter",
  Ollama = "ollama",
  OpencodeGo = "opencode-go",
}

export const SAiProvider = z.enum(EAiProvider);

export enum ERole {
  System = "system",
  User = "user",
  Assistant = "assistant",
}

export type TToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export enum EModelPurpose {
  Utility = "Utility",
  Main = "Main",
  Specialist = "Specialist",
  SpecialistAccurate = "SpecialistAccurate",
  ScheduledTask = "ScheduledTask",
}
