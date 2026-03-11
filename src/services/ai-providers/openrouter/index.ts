import { OpenRouter } from "@openrouter/sdk";
import type { Message } from "@openrouter/sdk/models";
import type { TOption } from "../../../types";

const OPENROUTER_API_KEY = Bun.env.OPENROUTER_API_KEY as string;

const MODEL = "google/gemini-3-flash-preview" as const;

type THistoryItem = {
  content: string;
  role: "system" | "user" | "assistant";
};

type TPrompt = {
  role: "system" | "user" | "assistant";
  content: Array<{
    type: "text";
    text: string;
  }>;
};

const SYSTEM_MESSAGE: TPrompt = {
  role: "system",
  content: [
    {
      type: "text",
      text: "You are a helpful personal assistant. You communicate with your supervisor via discord direct messages, you will be able to schedule reminders, find informasions in past messages, cooperate with user",
    },
    {
      type: "text",
      text: "You should always reply in Polish language. You should always use Europe/Warsaw time.",
    },
    { type: "text", text: "Don't mention your capabilities unless asked." },
  ],
};

export class OpenrouterAiProvider {
  private static _instance: OpenrouterAiProvider;

  private readonly openrouter: OpenRouter = new OpenRouter({ apiKey: OPENROUTER_API_KEY });

  private constructor() {}

  public static get instance(): OpenrouterAiProvider {
    if (!OpenrouterAiProvider._instance) {
      OpenrouterAiProvider._instance = new OpenrouterAiProvider();
    }

    return OpenrouterAiProvider._instance;
  }

  public async chat(prompt: TPrompt, history: THistoryItem[]): Promise<TOption<string>> {
    const messages: Message[] = [SYSTEM_MESSAGE, ...history];
    messages.push(prompt);

    const res = await this.openrouter.chat.send({
      stream: false,
      model: MODEL,
      messages,
    });

    const data = res.choices[0]?.message.content;
    console.log(data);

    if (!data) {
      return undefined;
    }

    return data.toString();
  }
}
