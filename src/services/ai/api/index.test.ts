import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { DefaultConfigRecord, EConfigKey } from "../../settings/schema";
import { aiModels } from "../providers/registry";
import { EAiProvider, EModelPurpose } from "../types";
import { AiConnector } from ".";

const ORIGINAL_OPENROUTER_API_KEY = Bun.env.OPENROUTER_API_KEY;

afterEach(() => {
  Bun.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER_API_KEY;
  aiModels.setProvider(openrouterProvider());
});

describe("AiConnector provider verification", () => {
  test("does not return raw provider payload or reasoning from a failed switch", async () => {
    Bun.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const faux = fauxProvider({
      provider: EAiProvider.Openrouter,
      models: [{ id: "google/gemini-3.1-pro-preview", reasoning: true }],
    });
    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage:
          '400: {"message":"invalid request","metadata":{"raw":"private prompt","reasoning":"private reasoning"}}',
      }),
    ]);
    aiModels.setProvider(faux.provider);

    const result = await AiConnector.instance.verifySettings(
      {
        ...DefaultConfigRecord,
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      },
      [EModelPurpose.ChatAccurate],
    );

    expect(result).toBe("Provider failed for ChatAccurate: Provider error status=400");
    expect(result).not.toContain("private prompt");
    expect(result).not.toContain("private reasoning");
  });
});
