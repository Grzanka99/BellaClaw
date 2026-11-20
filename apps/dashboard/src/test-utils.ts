import {
  ADDRESS_LINKED_ELSEWHERE,
  type TDashboardChatLink,
  type TDashboardLinkState,
  type TOption,
} from "@bellaclaw/shared";
import type { TInternalApi } from "./internal-api";

// An in-memory stand-in for the assistant's internal API, for tests. links: by chat key.
// activationCode: the configured code, undefined for none; codeChecks: every code checked.
// unreachableCalls: how many next requestLink, getChatLink or getAccount calls answer 502. Links are made active by activate().
export function createFakeAssistant() {
  const links = new Map<string, { accountId: string; state: TDashboardLinkState }>();
  const requests: { accountId: string; chatKey: string }[] = [];
  const calls: { method: string; accountId: string }[] = [];
  const state: { unreachableCalls: number; activationCode: TOption<string> } = {
    unreachableCalls: 0,
    activationCode: "open-sesame",
  };
  const codeChecks: string[] = [];
  const unavailable = { error: "The assistant is unavailable", status: 502 as const };

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

      const data: TDashboardChatLink = { link: links.get(chatKey) };

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
    deleteMessage: async (accountId, messageId) => {
      calls.push({ method: "deleteMessage", accountId });

      return { data: { deletedMessageIds: [messageId] } };
    },
  };

  return {
    internalApi,
    links,
    requests,
    calls,
    codeChecks,
    state,
    activate(chatKey: string) {
      const link = links.get(chatKey);

      if (link !== undefined) {
        link.state = "active";
      }
    },
  };
}
