import { afterEach, beforeEach, expect, type Mock, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, type OAuthCredential } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { AuthorizationService } from "../../authorization";
import { EventBus, type TEventContext, type TEventDraft } from "../../events";
import { EEventType } from "../../events/catalog";
import { EConfigKey } from "../../settings/schema";
import { FileCredentialStore } from "../providers/file-credential-store";
import { EAiProvider } from "../types";
import { checkAiOAuth, describeAiAuthProblem, EAiAuthState, getAiAuthState } from ".";

let directory: string;
let published: TEventDraft[];
let authorizedChats: Mock<() => Promise<string[]>>;
let publish: Mock<(draft: TEventDraft) => Promise<void>>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bellaclaw-ai-auth-"));
  published = [];
  authorizedChats = spyOn(AuthorizationService.instance, "listAuthorizedChatIds").mockResolvedValue(
    ["discord:auth-test"],
  );
  publish = spyOn(EventBus.instance, "publish").mockImplementation(async (draft) => {
    published.push(draft);
  });
});

afterEach(async () => {
  authorizedChats.mockRestore();
  publish.mockRestore();
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
            login: () => Promise.reject(new Error("Login is not supported")),
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
  expect(published).toEqual([]);
});

test("stays silent about an expired login while another provider is connected", async () => {
  const { models, store } = await createTestModels(() =>
    Promise.reject(new Error("token refresh failed (401): invalid_grant")),
  );
  await store.modify(EAiProvider.OpencodeGo, async () => ({
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: Date.now() + 60 * 60 * 1000,
  }));

  await checkAiOAuth(models);

  expect(published).toEqual([]);
});

test("publishes one combined alert for rejected and missing logins", async () => {
  const { models } = await createTestModels(() =>
    Promise.reject(new Error("token refresh failed (401): invalid_grant")),
  );

  await checkAiOAuth(models);
  await checkAiOAuth(models);

  expect(published.map((draft) => draft.payload)).toEqual([
    {
      problems: [
        "openai-codex: login expired. Run !ai-auth login openai-codex",
        "opencode-go: not connected. Run !ai-auth login opencode-go",
      ],
    },
  ]);
});

test("does not alert on transient refresh failures", async () => {
  const { models } = await createTestModels(() =>
    Promise.reject(new Error("token refresh error: fetch failed")),
  );
  await models.logout(EAiProvider.OpencodeGo);
  authorizedChats.mockResolvedValue([]);

  await checkAiOAuth(models);

  expect(published).toEqual([]);
});

test("retries an alert while no chat is authorized", async () => {
  const { models } = await createTestModels(() =>
    Promise.reject(new Error("token refresh failed (401): invalid_grant")),
  );
  authorizedChats.mockResolvedValue([]);

  await checkAiOAuth(models);
  authorizedChats.mockResolvedValue(["discord:retry-alert"]);
  await checkAiOAuth(models);
  await checkAiOAuth(models);

  expect(published.map((draft) => draft.payload)).toEqual([
    {
      problems: [
        "openai-codex: login expired. Run !ai-auth login openai-codex",
        "opencode-go: not connected. Run !ai-auth login opencode-go",
      ],
    },
  ]);
});

test("treats a rate-limited refresh as transient", async () => {
  const { models } = await createTestModels(() =>
    Promise.reject(new Error("OpenCode token refresh failed (429)")),
  );

  expect(await getAiAuthState(EAiProvider.OpenaiCodex, models)).toBe(EAiAuthState.Unavailable);
});

test("switches a failed chat to a connected provider through settings.update.requested", async () => {
  const { models } = await createTestModels(async (credential) => ({
    ...credential,
    expires: Date.now() + 60 * 60 * 1000,
  }));
  const request = mock(async () => undefined);
  const ctx = { request } as unknown as Pick<TEventContext, "request">;

  expect(await describeAiAuthProblem(ctx, "discord:switch", EAiProvider.OpencodeGo, models)).toBe(
    "opencode-go is not connected. Switched this chat to openai-codex. Send your message again.",
  );
  expect(request).toHaveBeenCalledWith(
    EEventType.SettingsUpdateRequested,
    {
      ownerKey: "discord:switch",
      updates: [{ key: EConfigKey.AiProvider, value: EAiProvider.OpenaiCodex }],
    },
    {
      outcome: EEventType.SettingsChanged,
      step: undefined,
      key: "discord:switch",
      timeoutMs: undefined,
    },
  );
});
