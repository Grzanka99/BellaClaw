import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, type OAuthCredential } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { EAiProvider } from "../types";
import { FileCredentialStore } from "./file-credential-store";
import { keepOpenaiCodexOAuthAlive } from "./oauth-keep-alive";

const temporaryDirectories: string[] = [];

async function createKeepAliveModels(refresh: (credential: OAuthCredential) => OAuthCredential) {
  const directory = await mkdtemp(join(tmpdir(), "bellaclaw-oauth-keep-alive-"));
  temporaryDirectories.push(directory);
  const store = new FileCredentialStore(join(directory, "pi-auth.json"));
  const models = createModels({ credentials: store });
  models.setProvider(
    createProvider({
      id: EAiProvider.OpenaiCodex,
      auth: {
        oauth: {
          name: "Test OAuth",
          login: () => Promise.reject(new Error("Login is not supported")),
          refresh: async (credential) => refresh(credential),
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: [],
      api: openAICodexResponsesApi(),
    }),
  );
  return { models, store };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("keepOpenaiCodexOAuthAlive", () => {
  test("refreshes and persists an expired OpenAI Codex credential", async () => {
    const { models, store } = await createKeepAliveModels((credential) => ({
      ...credential,
      access: "new-access",
      refresh: "new-refresh",
      expires: Date.now() + 60 * 60 * 1000,
    }));
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
  });

  test("keeps a valid OpenAI Codex credential unchanged", async () => {
    let refreshCount = 0;
    const { models, store } = await createKeepAliveModels((credential) => {
      refreshCount += 1;
      return credential;
    });
    const credential = {
      type: "oauth" as const,
      access: "access",
      refresh: "refresh",
      expires: Date.now() + 60 * 60 * 1000,
    };
    await store.modify(EAiProvider.OpenaiCodex, async () => credential);

    await keepOpenaiCodexOAuthAlive(models);

    expect(refreshCount).toBe(0);
    expect(await store.read(EAiProvider.OpenaiCodex)).toEqual(credential);
  });

  test("does not throw when the refresh fails", async () => {
    const { models, store } = await createKeepAliveModels(() => {
      throw new Error("invalid_grant");
    });
    await store.modify(EAiProvider.OpenaiCodex, async () => ({
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1000,
    }));

    await expect(keepOpenaiCodexOAuthAlive(models)).resolves.toBeUndefined();
  });
});
