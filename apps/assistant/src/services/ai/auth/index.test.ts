import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, type OAuthCredential } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { SettingsService } from "../../settings";
import { EConfigKey } from "../../settings/schema";
import { EAiProvider } from "../types";
import {
  beginAiLogin,
  checkAiOAuth,
  describeAiAuthProblem,
  EAiAuthState,
  getAiAuthState,
  registerAiAuthChannel,
} from ".";
import { FileCredentialStore } from "./file-credential-store";

let directory: string;
let sent: { chatId: string; text: string }[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bellaclaw-ai-auth-"));
  sent = [];
  registerAiAuthChannel({
    listChatIds: async () => ["discord:auth-test"],
    send: async (chatId, text) => {
      sent.push({ chatId, text });
    },
  });
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function createTestModels(
  refresh: (credential: OAuthCredential) => Promise<OAuthCredential>,
) {
  const store = new FileCredentialStore(join(directory, "pi-auth.json"));
  const models = createModels({ credentials: store });
  for (const id of [EAiProvider.OpenaiCodex, EAiProvider.OpencodeGo]) {
    models.setProvider(
      createProvider({
        id,
        auth: {
          oauth: {
            name: "Test OAuth",
            login: async (interaction) => {
              interaction.notify({
                type: "device_code",
                userCode: "CODE",
                verificationUri: "https://example.test/device",
              });
              return {
                type: "oauth",
                access: "login-access",
                refresh: "login-refresh",
                expires: Date.now() + 60 * 60 * 1000,
              };
            },
            refresh,
            toAuth: async (credential) => ({ apiKey: credential.access }),
          },
        },
        models: [],
        api: openAICodexResponsesApi(),
      }),
    );
  }
  await store.modify(EAiProvider.OpenaiCodex, async () => ({
    type: "oauth",
    access: "old-access",
    refresh: "old-refresh",
    expires: Date.now() - 1000,
  }));
  return { models, store };
}

test("refreshes and persists expired OAuth credentials", async () => {
  const { models, store } = await createTestModels(async (credential) => ({
    ...credential,
    access: "new-access",
    refresh: "new-refresh",
    expires: Date.now() + 60 * 60 * 1000,
  }));
  await store.modify(EAiProvider.OpencodeGo, async () => ({
    type: "oauth",
    access: "old-access",
    refresh: "old-refresh",
    expires: Date.now() - 1000,
  }));

  await checkAiOAuth(models);

  expect(await store.read(EAiProvider.OpenaiCodex)).toMatchObject({ refresh: "new-refresh" });
  expect(await store.read(EAiProvider.OpencodeGo)).toMatchObject({ refresh: "new-refresh" });
  expect(sent).toEqual([]);
});

test("sends one combined alert for rejected and missing logins", async () => {
  const { models } = await createTestModels(() =>
    Promise.reject(new Error("token refresh failed (401): invalid_grant")),
  );

  await checkAiOAuth(models);
  await checkAiOAuth(models);

  expect(sent).toEqual([
    {
      chatId: "discord:auth-test",
      text: [
        "AI login needed:",
        "- openai-codex: login expired. Run !ai-auth login openai-codex",
        "- opencode-go: not connected. Run !ai-auth login opencode-go",
      ].join("\n"),
    },
  ]);
});

test("does not alert on transient refresh failures", async () => {
  const { models } = await createTestModels(() =>
    Promise.reject(new Error("token refresh error: fetch failed")),
  );
  await models.logout(EAiProvider.OpencodeGo);
  registerAiAuthChannel({
    listChatIds: async () => [],
    send: async (chatId, text) => {
      sent.push({ chatId, text });
    },
  });

  await checkAiOAuth(models);

  expect(sent).toEqual([]);
});

test("retries an alert that no chat received", async () => {
  const { models } = await createTestModels(() =>
    Promise.reject(new Error("token refresh failed (401): invalid_grant")),
  );
  let failSend = true;
  registerAiAuthChannel({
    listChatIds: async () => ["discord:retry-alert"],
    send: async (chatId, text) => {
      if (failSend) {
        throw new Error("transport down");
      }
      sent.push({ chatId, text });
    },
  });

  await models.logout(EAiProvider.OpenaiCodex);
  await models.logout(EAiProvider.OpencodeGo);
  await checkAiOAuth(models);
  failSend = false;
  await checkAiOAuth(models);
  await checkAiOAuth(models);

  expect(sent).toEqual([
    {
      chatId: "discord:retry-alert",
      text: "AI login needed:\n- opencode-go: not connected. Run !ai-auth login opencode-go",
    },
  ]);
});

test("treats a rate-limited refresh as transient", async () => {
  const { models } = await createTestModels(() =>
    Promise.reject(new Error("OpenCode token refresh failed (429)")),
  );

  expect(await getAiAuthState(EAiProvider.OpenaiCodex, models)).toBe(EAiAuthState.Unavailable);
});

test.each([
  [false, "Connected openai-codex. It is now this chat's AI provider."],
  [true, "Connected openai-codex."],
])("selects the first connected provider for the chat (other connected: %p)", async (otherConnected, reply) => {
  const { models, store } = await createTestModels(() =>
    Promise.reject(new Error("token refresh failed (401): invalid_grant")),
  );
  if (otherConnected) {
    await store.modify(EAiProvider.OpencodeGo, async () => ({
      type: "oauth",
      access: "go-access",
      refresh: "go-refresh",
      expires: Date.now() + 60 * 60 * 1000,
    }));
  }
  const set = mock(async () => ({}));
  (SettingsService as unknown as { _instance: unknown })._instance = { set };
  const delivered = Promise.withResolvers<void>();
  registerAiAuthChannel({
    listChatIds: async () => [],
    send: async (chatId, text) => {
      sent.push({ chatId, text });
      delivered.resolve();
    },
  });

  await beginAiLogin("discord:login", EAiProvider.OpenaiCodex, models);
  await delivered.promise;

  expect(sent).toEqual([{ chatId: "discord:login", text: reply }]);
  if (otherConnected) {
    expect(set).not.toHaveBeenCalled();
  } else {
    expect(set).toHaveBeenCalledWith(
      "discord:login",
      EConfigKey.AiProvider,
      EAiProvider.OpenaiCodex,
    );
  }
});

test("switches a failed chat to a connected provider", async () => {
  const { models } = await createTestModels(async (credential) => ({
    ...credential,
    expires: Date.now() + 60 * 60 * 1000,
  }));
  const set = mock(async () => ({}));
  (SettingsService as unknown as { _instance: unknown })._instance = { set };

  expect(await describeAiAuthProblem("discord:switch", EAiProvider.OpencodeGo, models)).toBe(
    "opencode-go is not connected. Switched this chat to openai-codex. Send your message again.",
  );
  expect(set).toHaveBeenCalledWith(
    "discord:switch",
    EConfigKey.AiProvider,
    EAiProvider.OpenaiCodex,
  );
});
