import {
  createLogger,
  DASHBOARD_ACTIVATION_CHECK_PATH,
  DASHBOARD_LINKS_PATH,
  DASHBOARD_STREAM_PATH,
  dashboardAccountConversationMessagesPath,
  dashboardAccountMessagePath,
  dashboardAccountModelPath,
  dashboardAccountPath,
  dashboardChatLinkPath,
  SDashboardAccount,
  SDashboardActivationCheck,
  SDashboardAppMessageAccepted,
  SDashboardChatLink,
  SDashboardError,
  SDashboardLinkStarted,
  SDashboardMessageDeleted,
  SDashboardModelState,
  type TDashboardAccount,
  type TDashboardActivationCheck,
  type TDashboardActivationCheckRequest,
  type TDashboardAppMessage,
  type TDashboardAppMessageAccepted,
  type TDashboardChatLink,
  type TDashboardLinkRequest,
  type TDashboardLinkStarted,
  type TDashboardMessageDeleted,
  type TDashboardModelState,
  type TDashboardModelUpdate,
  type TOption,
} from "@bellaclaw/shared";
import type { z } from "zod";

// NOTE: a model change waits for the assistant's provider verification, which can take minutes.
// Just under the 255 s idle timeout of both servers, so the caller gets an answer.
const INTERNAL_API_TIMEOUT_MS = 250_000;
const UNAVAILABLE = "The assistant is unavailable";

const logger = createLogger("INTERNAL-API");

// status 400 carries the assistant's own error, and code the stable code of a rejected
// command; 404 is a conversation the account does not own; 502 is an unreachable or broken
// assistant
export type TInternalApiResult<T> =
  | { data: T }
  | { error: string; status: 400 | 404 | 502; code?: string };

// accountId: an account's public id; chatKey: an address, as a link token carries it
export type TInternalApi = {
  // code: what a person typed to register; the assistant holds the activation code
  checkActivationCode(code: string): Promise<TInternalApiResult<TDashboardActivationCheck>>;
  requestLink(
    accountId: string,
    chatKey: string,
  ): Promise<TInternalApiResult<TDashboardLinkStarted>>;
  getChatLink(chatKey: string): Promise<TInternalApiResult<TDashboardChatLink>>;
  getAccount(accountId: string): Promise<TInternalApiResult<TDashboardAccount>>;
  getModel(accountId: string): Promise<TInternalApiResult<TDashboardModelState>>;
  updateModel(
    accountId: string,
    update: TDashboardModelUpdate,
  ): Promise<TInternalApiResult<TDashboardModelState>>;
  deleteMessage(
    accountId: string,
    messageId: number,
  ): Promise<TInternalApiResult<TDashboardMessageDeleted>>;
  // answers once the message is stored, before its turn runs
  sendMessage(
    accountId: string,
    conversationKey: string,
    message: TDashboardAppMessage,
  ): Promise<TInternalApiResult<TDashboardAppMessageAccepted>>;
  // the assistant's live stream for every account, lines of JSON, open until either side closes
  // it; signal closes it
  openStream(signal: AbortSignal): Promise<TInternalApiResult<ReadableStream<Uint8Array>>>;
};

// The assistant's internal API. baseUrl has no trailing slash.
export function createInternalApi(baseUrl: string, secret: string): TInternalApi {
  async function call<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body: TOption<
      | TDashboardModelUpdate
      | TDashboardLinkRequest
      | TDashboardActivationCheckRequest
      | TDashboardAppMessage
    >,
  ): Promise<TInternalApiResult<T>> {
    let status: number;
    let payload: unknown;

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(INTERNAL_API_TIMEOUT_MS),
      });
      status = response.status;
      payload = await response.json();
    } catch (error) {
      logger.error(`${method} request failed: ${error}`);

      return { error: UNAVAILABLE, status: 502 };
    }

    if (status === 200) {
      const data = schema.safeParse(payload);

      if (data.success) {
        return { data: data.data };
      }
    }

    if (status === 400 || status === 404) {
      const failure = SDashboardError.safeParse(payload);

      if (failure.success) {
        return { error: failure.data.error, status, code: failure.data.code };
      }
    }

    logger.error(`${method} request answered ${status} with an unexpected body`);

    return { error: UNAVAILABLE, status: 502 };
  }

  return {
    checkActivationCode: (code) =>
      call("POST", DASHBOARD_ACTIVATION_CHECK_PATH, SDashboardActivationCheck, { code }),
    requestLink: (accountId, chatKey) =>
      call("POST", DASHBOARD_LINKS_PATH, SDashboardLinkStarted, { accountId, chatKey }),
    getChatLink: (chatKey) =>
      call("GET", dashboardChatLinkPath(chatKey), SDashboardChatLink, undefined),
    getAccount: (accountId) =>
      call("GET", dashboardAccountPath(accountId), SDashboardAccount, undefined),
    getModel: (accountId) =>
      call("GET", dashboardAccountModelPath(accountId), SDashboardModelState, undefined),
    updateModel: (accountId, update) =>
      call("PUT", dashboardAccountModelPath(accountId), SDashboardModelState, update),
    deleteMessage: (accountId, messageId) =>
      call(
        "DELETE",
        dashboardAccountMessagePath(accountId, messageId),
        SDashboardMessageDeleted,
        undefined,
      ),
    sendMessage: (accountId, conversationKey, message) =>
      call(
        "POST",
        dashboardAccountConversationMessagesPath(accountId, conversationKey),
        SDashboardAppMessageAccepted,
        message,
      ),
    // NOTE: no timeout: the stream stays open, and the assistant's keep-alives hold it
    openStream: async (signal) => {
      try {
        const response = await fetch(`${baseUrl}${DASHBOARD_STREAM_PATH}`, {
          headers: { Authorization: `Bearer ${secret}` },
          signal,
        });

        if (response.status === 200 && response.body !== null) {
          return { data: response.body };
        }

        logger.error(`Stream request answered ${response.status}`);
        await response.body?.cancel();
      } catch (error) {
        logger.error(`Stream request failed: ${error}`);
      }

      return { error: UNAVAILABLE, status: 502 };
    },
  };
}
