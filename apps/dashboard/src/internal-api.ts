import {
  createLogger,
  DASHBOARD_ACTIVATION_CHECK_PATH,
  DASHBOARD_LINKS_PATH,
  DASHBOARD_PRESENCE_PATH,
  DASHBOARD_STREAM_PATH,
  dashboardAccountConversationMediaFilePath,
  dashboardAccountConversationMediaPath,
  dashboardAccountConversationMessagesPath,
  dashboardAccountConversationPath,
  dashboardAccountConversationsPath,
  dashboardAccountDevicePath,
  dashboardAccountDevicesPath,
  dashboardAccountMessagePath,
  dashboardAccountModelPath,
  dashboardAccountPath,
  dashboardAccountPersonalityPath,
  dashboardChatLinkPath,
  SDashboardAccount,
  SDashboardActivationCheck,
  SDashboardAppMessageAccepted,
  SDashboardChatLink,
  SDashboardConversationCreated,
  SDashboardConversationDeleted,
  SDashboardDevice,
  SDashboardDevicesRemoved,
  SDashboardError,
  SDashboardLinkStarted,
  SDashboardMedia,
  SDashboardMessageDeleted,
  SDashboardModelState,
  SDashboardPersonality,
  SDashboardPresenceAccepted,
  type TDashboardAccount,
  type TDashboardActivationCheck,
  type TDashboardActivationCheckRequest,
  type TDashboardAppMessage,
  type TDashboardAppMessageAccepted,
  type TDashboardChatLink,
  type TDashboardConversationCreated,
  type TDashboardConversationDeleted,
  type TDashboardDevice,
  type TDashboardDeviceRegistration,
  type TDashboardDevicesRemoved,
  type TDashboardLinkRequest,
  type TDashboardLinkStarted,
  type TDashboardMedia,
  type TDashboardMessageDeleted,
  type TDashboardModelState,
  type TDashboardModelUpdate,
  type TDashboardPersonality,
  type TDashboardPersonalityUpdate,
  type TDashboardPresence,
  type TDashboardPresenceAccepted,
  type TOption,
} from "@bellaclaw/shared";
import type { z } from "zod";

// NOTE: a model change waits for the assistant's provider verification, which can take minutes.
// Just under the 255 s idle timeout of both servers, so the caller gets an answer.
const INTERNAL_API_TIMEOUT_MS = 250_000;
const UNAVAILABLE = "The assistant is unavailable";

const logger = createLogger("INTERNAL-API");

// status 400 carries the assistant's own error, and code the stable code of a rejected
// command; 404 is a conversation the account does not own; 410 an image this conversation does
// not keep; 413 an image too large, 415 one of an unsupported type or content; 502 is an
// unreachable or broken assistant
export type TInternalApiResult<T> =
  | { data: T }
  | { error: string; status: 400 | 404 | 410 | 413 | 415 | 502; code?: string };

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
  getPersonality(accountId: string): Promise<TInternalApiResult<TDashboardPersonality>>;
  updatePersonality(
    accountId: string,
    update: TDashboardPersonalityUpdate,
  ): Promise<TInternalApiResult<TDashboardPersonality>>;
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
  // a new plain chat of the account
  createConversation(accountId: string): Promise<TInternalApiResult<TDashboardConversationCreated>>;
  // streams an image's bytes to the assistant, which checks and stores them; the answer names it
  // for a send. mimeType: the type the client declared
  uploadMedia(
    accountId: string,
    conversationKey: string,
    mimeType: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<TInternalApiResult<TDashboardMedia>>;
  // the assistant's answer with the image's bytes and type, to pass on
  downloadMedia(
    accountId: string,
    conversationKey: string,
    mediaId: string,
  ): Promise<TInternalApiResult<Response>>;
  // a plain chat of the account with its history; 404 for any other conversation
  deleteConversation(
    accountId: string,
    conversationKey: string,
  ): Promise<TInternalApiResult<TDashboardConversationDeleted>>;
  // the assistant's live stream for every account, lines of JSON, open until either side closes
  // it; signal closes it
  openStream(signal: AbortSignal): Promise<TInternalApiResult<ReadableStream<Uint8Array>>>;
  // every account with an open app stream here, the whole set
  reportPresence(accountIds: string[]): Promise<TInternalApiResult<TDashboardPresenceAccepted>>;
  // the device of an app session of the account, its token and keys replacing any it had
  registerDevice(
    accountId: string,
    deviceId: string,
    registration: TDashboardDeviceRegistration,
  ): Promise<TInternalApiResult<TDashboardDevice>>;
  // 404 for a device the account does not hold
  unregisterDevice(
    accountId: string,
    deviceId: string,
  ): Promise<TInternalApiResult<TDashboardDevice>>;
  // every device of the account
  unregisterAccountDevices(
    accountId: string,
  ): Promise<TInternalApiResult<TDashboardDevicesRemoved>>;
};

// The assistant's internal API. baseUrl has no trailing slash.
export function createInternalApi(baseUrl: string, secret: string): TInternalApi {
  function call<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body: TOption<
      | TDashboardModelUpdate
      | TDashboardPersonalityUpdate
      | TDashboardLinkRequest
      | TDashboardActivationCheckRequest
      | TDashboardAppMessage
      | TDashboardPresence
      | TDashboardDeviceRegistration
    >,
  ): Promise<TInternalApiResult<T>> {
    return send(method, path, schema, "application/json", JSON.stringify(body));
  }

  async function send<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    contentType: string,
    body: TOption<BodyInit>,
  ): Promise<TInternalApiResult<T>> {
    let status: number;
    let payload: unknown;

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": contentType },
        body,
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

    if (status === 400 || status === 404 || status === 410 || status === 413 || status === 415) {
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
    getPersonality: (accountId) =>
      call("GET", dashboardAccountPersonalityPath(accountId), SDashboardPersonality, undefined),
    updatePersonality: (accountId, update) =>
      call("PUT", dashboardAccountPersonalityPath(accountId), SDashboardPersonality, update),
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
    uploadMedia: (accountId, conversationKey, mimeType, body) =>
      send(
        "POST",
        dashboardAccountConversationMediaPath(accountId, conversationKey),
        SDashboardMedia,
        mimeType,
        body ?? undefined,
      ),
    downloadMedia: async (accountId, conversationKey, mediaId) => {
      let response: Response;

      try {
        response = await fetch(
          `${baseUrl}${dashboardAccountConversationMediaFilePath(accountId, conversationKey, mediaId)}`,
          {
            headers: { Authorization: `Bearer ${secret}` },
            signal: AbortSignal.timeout(INTERNAL_API_TIMEOUT_MS),
          },
        );
      } catch (error) {
        logger.error(`Media request failed: ${error}`);

        return { error: UNAVAILABLE, status: 502 };
      }

      const status = response.status;

      if (status === 200) {
        return { data: response };
      }

      let payload: unknown;

      try {
        payload = await response.json();
      } catch {
        // no JSON fails the schema
      }

      const failure = SDashboardError.safeParse(payload);

      if ((status === 404 || status === 410) && failure.success) {
        return { error: failure.data.error, status };
      }

      logger.error(`Media request answered ${status} with an unexpected body`);

      return { error: UNAVAILABLE, status: 502 };
    },
    createConversation: (accountId) =>
      call(
        "POST",
        dashboardAccountConversationsPath(accountId),
        SDashboardConversationCreated,
        undefined,
      ),
    deleteConversation: (accountId, conversationKey) =>
      call(
        "DELETE",
        dashboardAccountConversationPath(accountId, conversationKey),
        SDashboardConversationDeleted,
        undefined,
      ),
    reportPresence: (accountIds) =>
      call("POST", DASHBOARD_PRESENCE_PATH, SDashboardPresenceAccepted, { accountIds }),
    registerDevice: (accountId, deviceId, registration) =>
      call("PUT", dashboardAccountDevicePath(accountId, deviceId), SDashboardDevice, registration),
    unregisterDevice: (accountId, deviceId) =>
      call("DELETE", dashboardAccountDevicePath(accountId, deviceId), SDashboardDevice, undefined),
    unregisterAccountDevices: (accountId) =>
      call("DELETE", dashboardAccountDevicesPath(accountId), SDashboardDevicesRemoved, undefined),
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
