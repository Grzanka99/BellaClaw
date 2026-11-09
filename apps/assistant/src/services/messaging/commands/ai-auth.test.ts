import { afterEach, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import { createProvider, type Provider } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { registerAiAuthChannel } from "../../ai/auth";
import { aiCredentials, aiModels } from "../../ai/providers/registry";
import { EAiProvider } from "../../ai/types";
import { AuthorizationService } from "../../authorization";
import { aiAuthCommand } from "./ai-auth";

let previousProvider: Provider | undefined;
let sent: { chatId: string; text: string }[];
let approve: () => void;
let authorizedChats: Mock<() => Promise<string[]>>;

beforeEach(() => {
  sent = [];
  authorizedChats = spyOn(AuthorizationService.instance, "listAuthorizedChatIds").mockResolvedValue(
    ["discord:1", "discord:2"],
  );
  registerAiAuthChannel({
    listChatIds: async () => [],
    send: async (chatId, text) => {
      sent.push({ chatId, text });
    },
  });
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
  authorizedChats.mockRestore();
  await aiCredentials.delete(EAiProvider.OpenaiCodex);
  if (previousProvider !== undefined) {
    aiModels.setProvider(previousProvider);
  }
});

test("logs in with a device code and confirms in the chat", async () => {
  expect(await aiAuthCommand.handler("discord:1", "login openai-codex")).toBe(
    "Open https://example.test/device and enter code ABCD-EFGH to connect openai-codex.",
  );

  approve();
  await Bun.sleep(10);

  expect(sent).toEqual([
    { chatId: "discord:1", text: "Connected openai-codex. It is now this chat's AI provider." },
  ]);
  expect(await aiAuthCommand.handler("discord:1", "status openai-codex")).toBe(
    "openai-codex: connected with OAuth, access token expires 2030-01-01T00:00:00.000Z.",
  );
  expect(await aiAuthCommand.handler("discord:1", "logout openai-codex")).toBe(
    "Logged out of openai-codex.",
  );
  expect(await aiAuthCommand.handler("discord:1", "status openai-codex")).toBe(
    "openai-codex: not connected.",
  );
});

test("cancels a pending login when a new one starts", async () => {
  await aiAuthCommand.handler("discord:1", "login openai-codex");
  await aiAuthCommand.handler("discord:2", "login openai-codex");

  approve();
  await Bun.sleep(10);

  expect(sent).toEqual([
    { chatId: "discord:2", text: "Connected openai-codex. It is now this chat's AI provider." },
  ]);
});

test("rejects unknown actions and providers", async () => {
  const usage = "Usage: !ai-auth login|status|logout PROVIDER (openai-codex, opencode-go)";

  expect(await aiAuthCommand.handler("discord:1", "login openrouter")).toBe(usage);
  expect(await aiAuthCommand.handler("discord:1", "refresh openai-codex")).toBe(usage);
});

test("refuses chats that are not activated", async () => {
  expect(await aiAuthCommand.handler("discord:stranger", "login openai-codex")).toBe(
    "AI authentication requires BELLACLAW_ACTIVATION_TOKEN and an activated chat.",
  );
  expect(await aiAuthCommand.handler("discord:stranger", "logout openai-codex")).toBe(
    "AI authentication requires BELLACLAW_ACTIVATION_TOKEN and an activated chat.",
  );
  expect(sent).toEqual([]);
});
