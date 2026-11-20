import {
  createLogger,
  GATEWAY_ACTIVATION_CHECK_PATH,
  GATEWAY_LINKS_PATH,
  GATEWAY_PRESENCE_PATH,
  GATEWAY_STREAM_PATH,
  gatewayAccountConversationMediaFilePath,
  gatewayAccountConversationMediaPath,
  gatewayAccountConversationMessagesPath,
  gatewayAccountConversationPath,
  gatewayAccountConversationsPath,
  gatewayAccountDevicePath,
  gatewayAccountDevicesPath,
  gatewayAccountMessagePath,
  gatewayAccountModelPath,
  gatewayAccountModelsPath,
  gatewayAccountPath,
  gatewayAccountPersonalityPath,
  gatewayChatLinkPath,
  SGatewayAccount,
  SGatewayActivationCheck,
  SGatewayAppMessageAccepted,
  SGatewayChatLink,
  SGatewayConversationCreated,
  SGatewayConversationDeleted,
  SGatewayDevice,
  SGatewayDevicesRemoved,
  SGatewayError,
  SGatewayLinkStarted,
  SGatewayMedia,
  SGatewayMessageDeleted,
  SGatewayModelCatalog,
  SGatewayModelState,
  SGatewayPersonality,
  SGatewayPresenceAccepted,
  type TGatewayAccount,
  type TGatewayActivationCheck,
  type TGatewayActivationCheckRequest,
  type TGatewayAppMessage,
  type TGatewayAppMessageAccepted,
  type TGatewayChatLink,
  type TGatewayConversationCreated,
  type TGatewayConversationDeleted,
  type TGatewayDevice,
  type TGatewayDeviceRegistration,
  type TGatewayDevicesRemoved,
  type TGatewayLinkRequest,
  type TGatewayLinkStarted,
  type TGatewayMedia,
  type TGatewayMessageDeleted,
  type TGatewayModelCatalog,
  type TGatewayModelState,
  type TGatewayModelUpdate,
  type TGatewayPersonality,
  type TGatewayPersonalityUpdate,
  type TGatewayPresence,
  type TGatewayPresenceAccepted,
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
  checkActivationCode(code: string): Promise<TInternalApiResult<TGatewayActivationCheck>>;
  requestLink(accountId: string, chatKey: string): Promise<TInternalApiResult<TGatewayLinkStarted>>;
  getChatLink(chatKey: string): Promise<TInternalApiResult<TGatewayChatLink>>;
  getAccount(accountId: string): Promise<TInternalApiResult<TGatewayAccount>>;
  getModel(accountId: string): Promise<TInternalApiResult<TGatewayModelState>>;
  updateModel(
    accountId: string,
    update: TGatewayModelUpdate,
  ): Promise<TInternalApiResult<TGatewayModelState>>;
  getModels(accountId: string): Promise<TInternalApiResult<TGatewayModelCatalog>>;
  getPersonality(accountId: string): Promise<TInternalApiResult<TGatewayPersonality>>;
  updatePersonality(
    accountId: string,
    update: TGatewayPersonalityUpdate,
  ): Promise<TInternalApiResult<TGatewayPersonality>>;
  deleteMessage(
    accountId: string,
    messageId: number,
  ): Promise<TInternalApiResult<TGatewayMessageDeleted>>;
  // answers once the message is stored, before its turn runs
  sendMessage(
    accountId: string,
    conversationKey: string,
    message: TGatewayAppMessage,
  ): Promise<TInternalApiResult<TGatewayAppMessageAccepted>>;
  // a new plain chat of the account
  createConversation(accountId: string): Promise<TInternalApiResult<TGatewayConversationCreated>>;
  // streams an image's bytes to the assistant, which checks and stores them; the answer names it
  // for a send. mimeType: the type the client declared
  uploadMedia(
    accountId: string,
    conversationKey: string,
    mimeType: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<TInternalApiResult<TGatewayMedia>>;
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
  ): Promise<TInternalApiResult<TGatewayConversationDeleted>>;
  // the assistant's live stream for every account, lines of JSON, open until either side closes
  // it; signal closes it
  openStream(signal: AbortSignal): Promise<TInternalApiResult<ReadableStream<Uint8Array>>>;
  // every account with an open app stream here, the whole set
  reportPresence(accountIds: string[]): Promise<TInternalApiResult<TGatewayPresenceAccepted>>;
  // the device of an app session of the account, its token and keys replacing any it had
  registerDevice(
    accountId: string,
    deviceId: string,
    registration: TGatewayDeviceRegistration,
  ): Promise<TInternalApiResult<TGatewayDevice>>;
  // 404 for a device the account does not hold
  unregisterDevice(
    accountId: string,
    deviceId: string,
  ): Promise<TInternalApiResult<TGatewayDevice>>;
  // every device of the account
  unregisterAccountDevices(accountId: string): Promise<TInternalApiResult<TGatewayDevicesRemoved>>;
};

// The assistant's internal API. baseUrl has no trailing slash.
export function createInternalApi(baseUrl: string, secret: string): TInternalApi {
  function call<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body: TOption<
      | TGatewayModelUpdate
      | TGatewayPersonalityUpdate
      | TGatewayLinkRequest
      | TGatewayActivationCheckRequest
      | TGatewayAppMessage
      | TGatewayPresence
      | TGatewayDeviceRegistration
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
      const failure = SGatewayError.safeParse(payload);

      if (failure.success) {
        return { error: failure.data.error, status, code: failure.data.code };
      }
    }

    logger.error(`${method} request answered ${status} with an unexpected body`);

    return { error: UNAVAILABLE, status: 502 };
  }

  return {
    checkActivationCode: (code) =>
      call("POST", GATEWAY_ACTIVATION_CHECK_PATH, SGatewayActivationCheck, { code }),
    requestLink: (accountId, chatKey) =>
      call("POST", GATEWAY_LINKS_PATH, SGatewayLinkStarted, { accountId, chatKey }),
    getChatLink: (chatKey) =>
      call("GET", gatewayChatLinkPath(chatKey), SGatewayChatLink, undefined),
    getAccount: (accountId) =>
      call("GET", gatewayAccountPath(accountId), SGatewayAccount, undefined),
    getModel: (accountId) =>
      call("GET", gatewayAccountModelPath(accountId), SGatewayModelState, undefined),
    updateModel: (accountId, update) =>
      call("PUT", gatewayAccountModelPath(accountId), SGatewayModelState, update),
    getModels: (accountId) =>
      call("GET", gatewayAccountModelsPath(accountId), SGatewayModelCatalog, undefined),
    getPersonality: (accountId) =>
      call("GET", gatewayAccountPersonalityPath(accountId), SGatewayPersonality, undefined),
    updatePersonality: (accountId, update) =>
      call("PUT", gatewayAccountPersonalityPath(accountId), SGatewayPersonality, update),
    deleteMessage: (accountId, messageId) =>
      call(
        "DELETE",
        gatewayAccountMessagePath(accountId, messageId),
        SGatewayMessageDeleted,
        undefined,
      ),
    sendMessage: (accountId, conversationKey, message) =>
      call(
        "POST",
        gatewayAccountConversationMessagesPath(accountId, conversationKey),
        SGatewayAppMessageAccepted,
        message,
      ),
    uploadMedia: (accountId, conversationKey, mimeType, body) =>
      send(
        "POST",
        gatewayAccountConversationMediaPath(accountId, conversationKey),
        SGatewayMedia,
        mimeType,
        body ?? undefined,
      ),
    downloadMedia: async (accountId, conversationKey, mediaId) => {
      let response: Response;

      try {
        response = await fetch(
          `${baseUrl}${gatewayAccountConversationMediaFilePath(accountId, conversationKey, mediaId)}`,
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

      const failure = SGatewayError.safeParse(payload);

      if ((status === 404 || status === 410) && failure.success) {
        return { error: failure.data.error, status };
      }

      logger.error(`Media request answered ${status} with an unexpected body`);

      return { error: UNAVAILABLE, status: 502 };
    },
    createConversation: (accountId) =>
      call(
        "POST",
        gatewayAccountConversationsPath(accountId),
        SGatewayConversationCreated,
        undefined,
      ),
    deleteConversation: (accountId, conversationKey) =>
      call(
        "DELETE",
        gatewayAccountConversationPath(accountId, conversationKey),
        SGatewayConversationDeleted,
        undefined,
      ),
    reportPresence: (accountIds) =>
      call("POST", GATEWAY_PRESENCE_PATH, SGatewayPresenceAccepted, { accountIds }),
    registerDevice: (accountId, deviceId, registration) =>
      call("PUT", gatewayAccountDevicePath(accountId, deviceId), SGatewayDevice, registration),
    unregisterDevice: (accountId, deviceId) =>
      call("DELETE", gatewayAccountDevicePath(accountId, deviceId), SGatewayDevice, undefined),
    unregisterAccountDevices: (accountId) =>
      call("DELETE", gatewayAccountDevicesPath(accountId), SGatewayDevicesRemoved, undefined),
    // NOTE: no timeout: the stream stays open, and the assistant's keep-alives hold it
    openStream: async (signal) => {
      try {
        const response = await fetch(`${baseUrl}${GATEWAY_STREAM_PATH}`, {
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
