import { afterEach, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { TOption } from "@bellaclaw/shared";
import { createProvider, type Provider } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { asc, eq } from "drizzle-orm";
import { setupAiAuth } from "../ai/auth";
import { aiCredentials, aiModels } from "../ai/providers/registry";
import { EAiProvider } from "../ai/types";
import { AuthorizationService } from "../authorization";
import { DatabaseConnector } from "../database";
import { eventsTable } from "../database/schema";
import { resetEventTables, resetUserConfigsTable } from "../database/test-utils";
import { ESubscriptionMode, EventBus } from "../events";
import { EEventType, type TEvent } from "../events/catalog";
import { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { EConfigKey } from "../settings/schema";
import { Commands } from ".";

let previousProvider: TOption<Provider>;
let bus: EventBus;
let approve: () => void;
let completed: Promise<TEvent<EEventType.AiAuthLoginCompleted>>;
let authorizedChats: Mock<() => Promise<string[]>>;

async function rowsOf(type: EEventType) {
  return DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, type))
    .orderBy(asc(eventsTable.seq));
}

// sends a message through the commands consumer and returns the chat's replies so far
async function send(chatId: string, content: string) {
  await bus.publish({
    type: EEventType.MessageAuthorized,
    source: "test",
    key: chatId,
    trace: { turnId: "test:ai-auth", chatId, platform: EMessagePlatform.Discord },
    payload: {
      chatId,
      content,
      attachments: [],
      receivedAt: Date.now(),
      platform: EMessagePlatform.Discord,
    },
    causationId: undefined,
    dedupeKey: undefined,
  });
  await bus.idle();
  return (await rowsOf(EEventType.ReplyReady))
    .map((row) => row.payload as { chatId: string; text: string })
    .filter((payload) => payload.chatId === chatId)
    .map((payload) => payload.text);
}

beforeEach(async () => {
  await resetEventTables();
  await resetUserConfigsTable();
  Object.assign(EventBus, { _instance: undefined });
  Object.assign(Commands, { _instance: undefined });
  Object.assign(SettingsService, { _instance: undefined });
  bus = EventBus.instance;
  Commands.instance.setup();
  SettingsService.instance.setup();
  setupAiAuth();
  const delivery = Promise.withResolvers<TEvent<EEventType.AiAuthLoginCompleted>>();
  completed = delivery.promise;
  bus.subscribe({
    consumer: "test-observer",
    type: EEventType.AiAuthLoginCompleted,
    mode: ESubscriptionMode.Live,
    backoffMs: [],
    handler: async (event) => {
      delivery.resolve(event);
    },
  });
  await bus.start();
  authorizedChats = spyOn(AuthorizationService.instance, "listAuthorizedChatIds").mockResolvedValue(
    ["discord:1", "discord:2"],
  );
  previousProvider = aiModels.getProvider(EAiProvider.OpenaiCodex);
  const approved = Promise.withResolvers<void>();
  approve = approved.resolve;
  aiModels.setProvider(
    createProvider({
      id: EAiProvider.OpenaiCodex,
      auth: {
        oauth: {
          name: "Test OAuth",
          login: async (interaction) => {
            const method = await interaction.prompt({
              type: "select",
              message: "Method",
              options: [
                { id: "browser", label: "Browser" },
                { id: "device_code", label: "Device code" },
              ],
            });
            if (method !== "device_code") {
              throw new Error(`Unexpected method ${method}`);
            }
            interaction.notify({
              type: "device_code",
              userCode: "ABCD-EFGH",
              verificationUri: "https://example.test/device",
            });
            await approved.promise;
            return {
              type: "oauth",
              access: "access",
              refresh: "refresh",
              expires: Date.UTC(2030, 0, 1),
            };
          },
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: [],
      api: openAICodexResponsesApi(),
    }),
  );
});

afterEach(async () => {
  await bus.idle();
  await bus.stop();
  authorizedChats.mockRestore();
  await aiCredentials.delete(EAiProvider.OpenaiCodex);
  if (previousProvider !== undefined) {
    aiModels.setProvider(previousProvider);
  }
});

test("logs in with a device code through ai.auth.login.requested and confirms in the chat", async () => {
  expect(await send("discord:1", "!ai-auth login openai-codex")).toEqual([
    "Open https://example.test/device and enter code ABCD-EFGH to connect openai-codex.",
  ]);
  expect((await rowsOf(EEventType.AiAuthLoginRequested))[0]?.key).toBe("global");

  approve();
  const event = await completed;
  await bus.idle();

  expect([event.key, event.payload]).toEqual([
    "discord:1",
    { chatId: "discord:1", providerId: "openai-codex", selected: true },
  ]);
  expect((await SettingsService.instance.getAll("discord:1"))[EConfigKey.AiProvider]).toBe(
    EAiProvider.OpenaiCodex,
  );
  expect(await send("discord:1", "!ai-auth status openai-codex")).toContain(
    "openai-codex: connected with OAuth, access token expires 2030-01-01T00:00:00.000Z.",
  );
  expect(await send("discord:1", "!ai-auth logout openai-codex")).toContain(
    "Logged out of openai-codex.",
  );
  expect(await rowsOf(EEventType.AiAuthLoggedOut)).toHaveLength(1);
  expect(await send("discord:1", "!ai-auth status openai-codex")).toContain(
    "openai-codex: not connected.",
  );
});

test("cancels a pending login when a new one starts", async () => {
  await send("discord:1", "!ai-auth login openai-codex");
  await send("discord:2", "!ai-auth login openai-codex");

  approve();
  const event = await completed;

  expect([event.key, event.payload]).toEqual([
    "discord:2",
    { chatId: "discord:2", providerId: "openai-codex", selected: true },
  ]);
});

test("rejects unknown actions and providers", async () => {
  const usage = "Usage: !ai-auth login|status|logout PROVIDER (openai-codex, opencode-go)";

  expect(await send("discord:1", "!ai-auth login openrouter")).toEqual([usage]);
  expect(await send("discord:1", "!ai-auth refresh openai-codex")).toEqual([usage, usage]);
});

test("refuses chats that are not activated", async () => {
  const refusal = "AI authentication requires BELLACLAW_ACTIVATION_TOKEN and an activated chat.";

  expect(await send("discord:stranger", "!ai-auth login openai-codex")).toEqual([refusal]);
  expect(await send("discord:stranger", "!ai-auth logout openai-codex")).toEqual([
    refusal,
    refusal,
  ]);
  expect(await rowsOf(EEventType.AiAuthLoginRequested)).toEqual([]);
  expect(await rowsOf(EEventType.AiAuthLogoutRequested)).toEqual([]);
});
