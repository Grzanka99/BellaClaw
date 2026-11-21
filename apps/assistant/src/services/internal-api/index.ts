import { createHash, timingSafeEqual } from "node:crypto";
import { findOwnedConversationKind } from "@bellaclaw/database";
import {
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
  MAX_IMAGE_BYTES,
  type TOption,
} from "@bellaclaw/shared";
import { sanitizeErrorMessage } from "../app-logger/sanitizers";
import { DatabaseConnector } from "../database";
import { CommandRejectedError } from "../events";
import { IdentityService } from "../identity";
import {
  handleAccount,
  handleActivationCheck,
  handleChatLink,
  handlePresence,
  openStream,
  requestLink,
} from "./account-routes";
import {
  handleAccountDevices,
  handleAppMessage,
  handleConversationCreate,
  handleConversationDelete,
  handleDevice,
  handleMediaDownload,
  handleMediaUpload,
  handleMessageDelete,
} from "./app-routes";
import { createModelCatalog, handleModel, handlePersonality } from "./settings-routes";
import { errorResponse } from "./shared";

export { setupInternalApi } from "./outcomes";

// every body but an image upload is a small JSON object
const MAX_JSON_BODY_BYTES = 65_536;

let server: TOption<ReturnType<typeof Bun.serve>>;

export async function handleInternalApiRequest(
  request: Request,
  secret: string,
): Promise<Response> {
  const digest = (value: string) => createHash("sha256").update(value).digest();

  // digests have one length, so the comparison is constant-time for any header
  if (
    !timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${secret}`))
  ) {
    return errorResponse("Unauthorized", 401, undefined);
  }

  const { pathname } = new URL(request.url);
  // ["", "internal", "activation-code", "check"], ["", "internal", "stream"],
  // ["", "internal", "links"],
  // ["", "internal", "links", chatKey],
  // ["", "internal", "accounts", accountId], ["", "internal", "accounts", accountId, "model"],
  // ["", "internal", "accounts", accountId, "models"],
  // ["", "internal", "accounts", accountId, "personality"] or
  // ["", "internal", "accounts", accountId, "messages", messageId] or
  // ["", "internal", "accounts", accountId, "conversations"] or
  // ["", "internal", "accounts", accountId, "conversations", conversationKey] or
  // ["", "internal", "accounts", accountId, "conversations", conversationKey, "messages"] or
  // ["", "internal", "accounts", accountId, "conversations", conversationKey, "media"] or
  // ["", "internal", "accounts", accountId, "conversations", conversationKey, "media", mediaId] or
  // ["", "internal", "accounts", accountId, "devices"] or
  // ["", "internal", "accounts", accountId, "devices", deviceId], ["", "internal", "presence"]
  const segments = pathname.split("/");
  const messageId = Number(segments[5]);
  let key = "";
  // a conversation key, or a device id on the device route
  let itemKey = "";
  let mediaId = "";

  try {
    key = decodeURIComponent(segments[3] ?? "");
    itemKey = decodeURIComponent(segments[5] ?? "");
    mediaId = decodeURIComponent(segments[7] ?? "");
  } catch {
    // a malformed escape is an unknown route
  }

  const activationRoute = request.method === "POST" && pathname === GATEWAY_ACTIVATION_CHECK_PATH;
  const linkRequestRoute = request.method === "POST" && pathname === GATEWAY_LINKS_PATH;
  const streamRoute = request.method === "GET" && pathname === GATEWAY_STREAM_PATH;
  const presenceRoute = request.method === "POST" && pathname === GATEWAY_PRESENCE_PATH;
  const chatLinkRoute =
    request.method === "GET" && key.length > 0 && pathname === gatewayChatLinkPath(key);
  const accountRoute =
    request.method === "GET" && key.length > 0 && pathname === gatewayAccountPath(key);
  const modelRoute =
    key.length > 0 &&
    pathname === gatewayAccountModelPath(key) &&
    (request.method === "GET" || request.method === "PUT");
  const modelsRoute =
    request.method === "GET" && key.length > 0 && pathname === gatewayAccountModelsPath(key);
  const personalityRoute =
    key.length > 0 &&
    pathname === gatewayAccountPersonalityPath(key) &&
    (request.method === "GET" || request.method === "PUT");
  const messageDeleteRoute =
    request.method === "DELETE" &&
    key.length > 0 &&
    Number.isSafeInteger(messageId) &&
    pathname === gatewayAccountMessagePath(key, messageId);
  const appMessageRoute =
    request.method === "POST" &&
    key.length > 0 &&
    itemKey.length > 0 &&
    pathname === gatewayAccountConversationMessagesPath(key, itemKey);
  const conversationCreateRoute =
    request.method === "POST" &&
    key.length > 0 &&
    pathname === gatewayAccountConversationsPath(key);
  const conversationDeleteRoute =
    request.method === "DELETE" &&
    key.length > 0 &&
    itemKey.length > 0 &&
    pathname === gatewayAccountConversationPath(key, itemKey);

  const mediaUploadRoute =
    request.method === "POST" &&
    key.length > 0 &&
    itemKey.length > 0 &&
    pathname === gatewayAccountConversationMediaPath(key, itemKey);
  const mediaDownloadRoute =
    request.method === "GET" &&
    key.length > 0 &&
    itemKey.length > 0 &&
    mediaId.length > 0 &&
    pathname === gatewayAccountConversationMediaFilePath(key, itemKey, mediaId);
  const deviceRoute =
    (request.method === "PUT" || request.method === "DELETE") &&
    key.length > 0 &&
    itemKey.length > 0 &&
    pathname === gatewayAccountDevicePath(key, itemKey);
  const accountDevicesRoute =
    request.method === "DELETE" && key.length > 0 && pathname === gatewayAccountDevicesPath(key);

  if (
    !activationRoute &&
    !linkRequestRoute &&
    !streamRoute &&
    !presenceRoute &&
    !chatLinkRoute &&
    !accountRoute &&
    !modelRoute &&
    !modelsRoute &&
    !personalityRoute &&
    !messageDeleteRoute &&
    !appMessageRoute &&
    !conversationCreateRoute &&
    !conversationDeleteRoute &&
    !mediaUploadRoute &&
    !mediaDownloadRoute &&
    !deviceRoute &&
    !accountDevicesRoute
  ) {
    return errorResponse("Not found", 404, undefined);
  }

  // NOTE: the server takes a body as large as an image, for the upload
  if (!mediaUploadRoute && Number(request.headers.get("content-length")) > MAX_JSON_BODY_BYTES) {
    return errorResponse("Request body too large", 413, undefined);
  }

  try {
    if (activationRoute) {
      return await handleActivationCheck(request);
    }

    if (streamRoute) {
      return openStream(request);
    }

    if (presenceRoute) {
      return await handlePresence(request);
    }

    if (linkRequestRoute) {
      return Response.json(await requestLink(await request.json()));
    }

    if (chatLinkRoute) {
      return await handleChatLink(key);
    }

    const account = await IdentityService.instance.account(key);

    if (accountRoute) {
      return handleAccount(account);
    }

    // a conversation route answers 404 for a conversation that is not the account's
    if (appMessageRoute || mediaUploadRoute || mediaDownloadRoute || conversationDeleteRoute) {
      const kind = await DatabaseConnector.instance.run((db) =>
        findOwnedConversationKind(db, itemKey, account),
      );

      if (kind === undefined) {
        return errorResponse("Not found", 404, undefined);
      }

      if (appMessageRoute) {
        return await handleAppMessage(request, key, account, itemKey, kind);
      }

      if (mediaUploadRoute) {
        return await handleMediaUpload(request, key, account, itemKey);
      }

      if (mediaDownloadRoute) {
        return await handleMediaDownload(itemKey, mediaId);
      }

      return await handleConversationDelete(account, itemKey, kind);
    }

    if (deviceRoute) {
      return await handleDevice(request, key, account, itemKey);
    }

    if (accountDevicesRoute) {
      return await handleAccountDevices(key, account);
    }

    if (conversationCreateRoute) {
      return await handleConversationCreate(account);
    }

    if (messageDeleteRoute) {
      return await handleMessageDelete(account, messageId);
    }

    if (modelsRoute) {
      return Response.json(await createModelCatalog());
    }

    if (personalityRoute) {
      return await handlePersonality(request, account);
    }

    return await handleModel(request, account);
  } catch (error) {
    let message = String(error);
    let code: TOption<string>;

    if (error instanceof Error) {
      message = error.message;
    }

    if (error instanceof CommandRejectedError) {
      code = error.errorCode;
    }

    return errorResponse(sanitizeErrorMessage(message) ?? "", 400, code);
  }
}

// starts only when BELLACLAW_GATEWAY_SECRET is set
export function startInternalApiServer(): void {
  const secret = Bun.env.BELLACLAW_GATEWAY_SECRET?.trim();

  if (server !== undefined || secret === undefined || secret.length === 0) {
    return;
  }

  const configuredPort = Bun.env.BELLACLAW_INTERNAL_API_PORT?.trim();
  let port = 3081;

  if (configuredPort !== undefined && configuredPort.length > 0) {
    port = Number(configuredPort);

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("BELLACLAW_INTERNAL_API_PORT must be an integer from 1 to 65535");
    }
  }

  server = Bun.serve({
    hostname: Bun.env.BELLACLAW_INTERNAL_API_HOSTNAME?.trim() || "127.0.0.1",
    port,
    // an image upload; a declared Content-Length above MAX_JSON_BODY_BYTES is refused for every
    // route but the upload
    maxRequestBodySize: MAX_IMAGE_BYTES,
    // NOTE: the maximum. A model change waits for a provider verification, far beyond the
    // default 10 s.
    idleTimeout: 255,
    fetch: (request) => handleInternalApiRequest(request, secret),
  });
}

export async function stopInternalApiServer(): Promise<void> {
  if (server === undefined) {
    return;
  }

  // NOTE: open requests are closed. They wait on the bus, which stops at the same time.
  await server.stop(true);
  server = undefined;
}
