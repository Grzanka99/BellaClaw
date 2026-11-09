import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { EAiProvider } from "../types";
import { FileCredentialStore } from "./file-credential-store";
import { keepOpenaiCodexOAuthAlive } from "./oauth-keep-alive";

test("refreshes and persists an expired OpenAI Codex credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bellaclaw-oauth-keep-alive-"));
  try {
    const store = new FileCredentialStore(join(directory, "pi-auth.json"));
    const models = createModels({ credentials: store });
    models.setProvider(
      createProvider({
        id: EAiProvider.OpenaiCodex,
        auth: {
          oauth: {
            name: "Test OAuth",
            login: () => Promise.reject(new Error("Login is not supported")),
            refresh: async (credential) => ({
              ...credential,
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            }),
            toAuth: async (credential) => ({ apiKey: credential.access }),
          },
        },
        models: [],
        api: openAICodexResponsesApi(),
      }),
    );
    await store.modify(EAiProvider.OpenaiCodex, async () => ({
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1000,
    }));

    await keepOpenaiCodexOAuthAlive(models);

    expect(await store.read(EAiProvider.OpenaiCodex)).toMatchObject({
      access: "new-access",
      refresh: "new-refresh",
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
