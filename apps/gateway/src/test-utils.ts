import {
  ADDRESS_LINKED_ELSEWHERE,
  type TGatewayAppMessage,
  type TGatewayChatLink,
  type TGatewayDeviceRegistration,
  type TGatewayLinkState,
  type TGatewayModelCatalog,
  type TGatewayPersonality,
  type TGatewayStreamEvent,
  type TOption,
} from "@bellaclaw/shared";
import type { TInternalApi } from "./internal-api";

// the catalog the fake assistant's getModels answers
export const FAKE_MODEL_CATALOG: TGatewayModelCatalog = {
  providers: [
    {
      id: "openrouter",
      usable: true,
      models: [{ id: "openai/gpt-5", name: "GPT-5", supportedEfforts: ["low", "high"] }],
    },
    {
      id: "opencode-go",
      usable: false,
      reason: "opencode-go is not connected.",
      models: [{ id: "grok-4.7", name: "Grok 4.7", supportedEfforts: ["high"] }],
    },
  ],
};

// An in-memory stand-in for the assistant's internal API, for tests. links: by chat key.
// activationCode: the configured code, undefined for none; codeChecks: every code checked.
// unreachableCalls: how many next requestLink, getChatLink or getAccount calls answer 502. Links are made active by activate().
// sends: every message sent, accepted as the assistant does, without a turn. streams: the stream
// opened by each openStream call, oldest first; push writes an event to the newest, drop closes it.
// personalities: by account id. uploads: every image streamed on, with its bytes; the fake answers
// it with the id `media-<n>`, and a download of that id with the bytes. devices: by device id, as
// the assistant keeps them; unreachableCalls also counts registerDevice, unregisterDevice and
// unregisterAccountDevices. presence: every set reportPresence delivered, oldest first;
// failingPresenceReports: how many next reportPresence calls answer 502
export function createFakeAssistant() {
  const personalities = new Map<string, TGatewayPersonality>();
  const defaultPersonality: TGatewayPersonality = {
    bellaPersona: "You are Bella.",
    plainChatsUseBellaPersona: true,
    plainChatsPersona: "",
  };
  const links = new Map<string, { accountId: string; state: TGatewayLinkState }>();
  const requests: { accountId: string; chatKey: string }[] = [];
  const calls: { method: string; accountId: string }[] = [];
  const state: {
    unreachableCalls: number;
    activationCode: TOption<string>;
    failingPresenceReports: number;
  } = {
    unreachableCalls: 0,
    activationCode: "open-sesame",
    failingPresenceReports: 0,
  };
  const codeChecks: string[] = [];
  const sends: { accountId: string; conversationKey: string; message: TGatewayAppMessage }[] = [];
  const uploads: {
    accountId: string;
    conversationKey: string;
    mimeType: string;
    data: ArrayBuffer;
  }[] = [];
  const unavailable = { error: "The assistant is unavailable", status: 502 as const };
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const devices = new Map<
    string,
    { accountId: string; registration: TGatewayDeviceRegistration }
  >();
  const presence: string[][] = [];
  const encoder = new TextEncoder();

  function reachable(): boolean {
    if (state.unreachableCalls > 0) {
      state.unreachableCalls -= 1;
      return false;
    }

    return true;
  }

  const internalApi: TInternalApi = {
    checkActivationCode: async (code) => {
      codeChecks.push(code);

      if (state.activationCode === undefined) {
        return { data: { result: "unset" } };
      }

      if (code.trim() === state.activationCode) {
        return { data: { result: "valid" } };
      }

      return { data: { result: "invalid" } };
    },
    requestLink: async (accountId, chatKey) => {
      if (!reachable()) {
        return unavailable;
      }

      requests.push({ accountId, chatKey });
      const existing = links.get(chatKey);

      if (existing !== undefined && existing.accountId !== accountId) {
        return {
          error: "The address is linked to another account",
          status: 400,
          code: ADDRESS_LINKED_ELSEWHERE,
        };
      }

      if (existing?.state === "migrating") {
        return { error: "The address is already being linked", status: 400 };
      }

      if (existing === undefined) {
        links.set(chatKey, { accountId, state: "migrating" });
      }

      return { data: { state: "migrating" } };
    },
    getChatLink: async (chatKey) => {
      if (!reachable()) {
        return unavailable;
      }

      const data: TGatewayChatLink = { link: links.get(chatKey) };

      return { data };
    },
    getAccount: async (accountId) => {
      if (!reachable()) {
        return unavailable;
      }

      calls.push({ method: "getAccount", accountId });

      return {
        data: {
          conversationKey: `bella:${accountId}`,
          ownerKey: `account:${accountId}`,
          links: [...links.entries()]
            .filter(([, link]) => link.accountId === accountId)
            .map(([chatKey, link]) => ({ chatKey, state: link.state, linkedAt: 1_000 })),
        },
      };
    },
    getModel: async (accountId) => {
      calls.push({ method: "getModel", accountId });

      return unavailable;
    },
    updateModel: async (accountId) => {
      calls.push({ method: "updateModel", accountId });

      return unavailable;
    },
    getModels: async (accountId) => {
      calls.push({ method: "getModels", accountId });

      return { data: FAKE_MODEL_CATALOG };
    },
    getPersonality: async (accountId) => {
      calls.push({ method: "getPersonality", accountId });

      return { data: personalities.get(accountId) ?? defaultPersonality };
    },
    updatePersonality: async (accountId, update) => {
      calls.push({ method: "updatePersonality", accountId });

      const next = { ...(personalities.get(accountId) ?? defaultPersonality), ...update };
      personalities.set(accountId, next);

      return { data: next };
    },
    deleteMessage: async (accountId, messageId) => {
      calls.push({ method: "deleteMessage", accountId });

      return { data: { deletedMessageIds: [messageId] } };
    },
    sendMessage: async (accountId, conversationKey, message) => {
      sends.push({ accountId, conversationKey, message });

      return { data: { clientMessageId: message.clientMessageId } };
    },
    uploadMedia: async (accountId, conversationKey, mimeType, body) => {
      const data = await new Response(body).arrayBuffer();
      uploads.push({ accountId, conversationKey, mimeType, data });

      return { data: { id: `media-${uploads.length}`, mimeType } };
    },
    downloadMedia: async (accountId, conversationKey, mediaId) => {
      const upload = uploads[Number(mediaId.slice("media-".length)) - 1];

      if (
        upload === undefined ||
        upload.accountId !== accountId ||
        upload.conversationKey !== conversationKey
      ) {
        return { error: "Gone", status: 410 };
      }

      return { data: new Response(upload.data, { headers: { "Content-Type": upload.mimeType } }) };
    },
    createConversation: async (accountId) => {
      calls.push({ method: "createConversation", accountId });

      return { data: { conversationKey: `plain:${accountId}:${calls.length}`, createdAt: 1_000 } };
    },
    deleteConversation: async (accountId, conversationKey) => {
      calls.push({ method: "deleteConversation", accountId });

      return { data: { conversationKey } };
    },
    reportPresence: async (accountIds) => {
      if (state.failingPresenceReports > 0) {
        state.failingPresenceReports -= 1;
        return unavailable;
      }

      presence.push(accountIds);

      return { data: { ok: true } };
    },
    registerDevice: async (accountId, deviceId, registration) => {
      if (!reachable()) {
        return unavailable;
      }

      devices.set(deviceId, { accountId, registration });

      return { data: { deviceId } };
    },
    unregisterDevice: async (accountId, deviceId) => {
      if (!reachable()) {
        return unavailable;
      }

      if (devices.get(deviceId)?.accountId !== accountId) {
        return { error: "Not found", status: 404 };
      }

      devices.delete(deviceId);

      return { data: { deviceId } };
    },
    unregisterAccountDevices: async (accountId) => {
      if (!reachable()) {
        return unavailable;
      }

      const deviceIds = [...devices]
        .filter(([, device]) => device.accountId === accountId)
        .map(([deviceId]) => deviceId);

      for (const deviceId of deviceIds) {
        devices.delete(deviceId);
      }

      return { data: { deviceIds } };
    },
    openStream: async (signal) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
          signal.addEventListener("abort", () => {
            try {
              controller.close();
            } catch {
              // dropped already
            }
          });
        },
      });

      return { data: body };
    },
  };

  return {
    internalApi,
    links,
    requests,
    calls,
    codeChecks,
    sends,
    uploads,
    personalities,
    state,
    streams,
    devices,
    presence,
    push(event: TGatewayStreamEvent) {
      streams.at(-1)?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    },
    drop() {
      streams.at(-1)?.close();
    },
    activate(chatKey: string) {
      const link = links.get(chatKey);

      if (link !== undefined) {
        link.state = "active";
      }
    },
  };
}
