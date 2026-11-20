import { createMessageTurnId } from "@bellaclaw/behavior-logs";
import { EConversationKind, EEventType } from "@bellaclaw/database";
import {
  CONVERSATION_NOT_FOUND,
  DEVICE_NOT_FOUND,
  isP256PublicKey,
  MAX_IMAGE_BYTES,
  SGatewayAppMessage,
  SGatewayDeviceId,
  SGatewayDeviceRegistration,
  type TGatewayAppMessageAccepted,
  type TGatewayConversationCreated,
  type TGatewayConversationDeleted,
  type TGatewayDevice,
  type TGatewayDevicesRemoved,
  type TGatewayMedia,
  type TGatewayMessageDeleted,
  type TOption,
} from "@bellaclaw/shared";
import { AppChannel, imageTypeOf } from "../app";
import { DatabaseConnector } from "../database";
import { CommandRejectedError, EventBus } from "../events";
import type { TModelChoice } from "../events/catalog";
import type { TAccountKeys } from "../identity";
import { EMessagePlatform, SUPPORTED_IMAGE_TYPES } from "../messaging/types";
import { COMMAND_TIMEOUT_MS, DELETE_TIMEOUT_MS, requestOutcome } from "./outcomes";
import { checkModelChoice } from "./settings-routes";
import { describeIssues, errorResponse, systemTrace } from "./shared";

// The request's body, read until it passes maxBytes; undefined when it does
async function readBody(request: Request, maxBytes: number): Promise<TOption<Uint8Array>> {
  if (request.body === null) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  // leaving the loop cancels the rest of the body
  for await (const chunk of request.body) {
    size += chunk.byteLength;

    if (size > maxBytes) {
      return undefined;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

// NOTE: the send answers once message.received is stored and waits for no outcome. The client's
// id is the dedupe key, so a repeated send stores nothing and answers the same. Authorization
// checks the ownership again before the message reaches a turn. A plain chat's send carries
// its model, checked here; the Bella conversation runs on the account's settings
export async function handleAppMessage(
  request: Request,
  accountId: string,
  account: TAccountKeys,
  conversationKey: string,
  kind: EConversationKind,
): Promise<Response> {
  const message = SGatewayAppMessage.safeParse(await request.json());

  if (!message.success) {
    throw new Error(describeIssues(message.error));
  }

  const { clientMessageId, text, images = [] } = message.data;
  const dedupeKey = `app:${conversationKey}:${clientMessageId}`;
  const body: TGatewayAppMessageAccepted = { clientMessageId };

  // NOTE: a repeated send is the stored message, answered before the model check: its provider
  // may have become unusable since
  if (await EventBus.instance.holds(dedupeKey)) {
    return Response.json(body);
  }

  let model: TOption<TModelChoice>;

  if (kind === EConversationKind.Plain) {
    if (message.data.model === undefined) {
      throw new Error("A message to a plain chat names its model");
    }

    model = await checkModelChoice(message.data.model);
  } else if (message.data.model !== undefined) {
    throw new Error("The Bella conversation runs on the account's model settings");
  }

  // the message names its images; their bytes stay in the App channel's store
  const attachments = await DatabaseConnector.instance.run((db) =>
    AppChannel.instance.findAttachments(db, accountId, conversationKey, images),
  );

  if (attachments.length !== images.length) {
    throw new Error("An image was not uploaded to this chat");
  }

  await EventBus.instance.publish({
    type: EEventType.MessageReceived,
    source: "internal-api",
    key: conversationKey,
    trace: {
      turnId: createMessageTurnId(),
      chatId: conversationKey,
      platform: EMessagePlatform.App,
    },
    // the app has no address; the account stands for it
    payload: {
      conversationKey,
      ownerKey: account.ownerKey,
      channel: EMessagePlatform.App,
      replyAddress: accountId,
      content: text,
      attachments,
      receivedAt: Date.now(),
      clientMessageId,
      model,
    },
    causationId: undefined,
    dedupeKey,
  });

  return Response.json(body);
}

// NOTE: everything is checked before anything is stored: the conversation, the declared type,
// the size while the body is read, and the format the bytes really have
export async function handleMediaUpload(
  request: Request,
  accountId: string,
  account: TAccountKeys,
  conversationKey: string,
): Promise<Response> {
  const mimeType = request.headers.get("content-type") ?? "";

  if (!SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
    return errorResponse("Unsupported image type", 415, undefined);
  }

  const data = await readBody(request, MAX_IMAGE_BYTES);

  if (data === undefined) {
    return errorResponse("The image is larger than 5 MB", 413, undefined);
  }

  if (imageTypeOf(data) !== mimeType) {
    return errorResponse(`The content is not ${mimeType}`, 415, undefined);
  }

  const body: TOption<TGatewayMedia> = await AppChannel.instance.store(
    accountId,
    account,
    conversationKey,
    mimeType,
    data,
  );

  // the plain chat was deleted while the body was read
  if (body === undefined) {
    return errorResponse("Not found", 404, undefined);
  }

  return Response.json(body);
}

// 410 for an image this conversation does not keep
export async function handleMediaDownload(
  conversationKey: string,
  mediaId: string,
): Promise<Response> {
  const media = await AppChannel.instance.open(conversationKey, mediaId);

  if (media === undefined) {
    return errorResponse("Gone", 410, undefined);
  }

  return new Response(media.file, {
    headers: { "Content-Type": media.mimeType, "Cache-Control": "no-store" },
  });
}

// NOTE: on the global lane, so a device's registers and unregisters apply in order. An
// unregister of a device the account does not hold is a 404
export async function handleDevice(
  request: Request,
  accountId: string,
  account: TAccountKeys,
  rawDeviceId: string,
): Promise<Response> {
  const deviceId = SGatewayDeviceId.safeParse(rawDeviceId);

  if (!deviceId.success) {
    throw new Error("Invalid device id");
  }

  const trace = systemTrace(account.conversationKey);
  const body: TGatewayDevice = { deviceId: deviceId.data };

  if (request.method === "PUT") {
    const registration = SGatewayDeviceRegistration.safeParse(await request.json());

    if (!registration.success) {
      throw new Error(describeIssues(registration.error));
    }

    if (!(await isP256PublicKey(registration.data.publicKey))) {
      throw new Error("Expected a P-256 public key");
    }

    await requestOutcome(
      trace,
      "global",
      EEventType.AppDeviceRegisterRequested,
      { deviceId: deviceId.data, accountId, ...registration.data },
      EEventType.AppDeviceRegistered,
      () => undefined,
      COMMAND_TIMEOUT_MS,
      "Registering the device timed out",
    );

    return Response.json(body);
  }

  try {
    await requestOutcome(
      trace,
      "global",
      EEventType.AppDeviceUnregisterRequested,
      { deviceId: deviceId.data, accountId },
      EEventType.AppDeviceUnregistered,
      () => undefined,
      COMMAND_TIMEOUT_MS,
      "Unregistering the device timed out",
    );
  } catch (error) {
    if (error instanceof CommandRejectedError && error.errorCode === DEVICE_NOT_FOUND) {
      return errorResponse("Not found", 404, undefined);
    }

    throw error;
  }

  return Response.json(body);
}

// every device of the account, one unregister each; one gone meanwhile counts as removed
export async function handleAccountDevices(
  accountId: string,
  account: TAccountKeys,
): Promise<Response> {
  const body: TGatewayDevicesRemoved = {
    deviceIds: await AppChannel.instance.listDeviceIds(accountId),
  };

  for (const deviceId of body.deviceIds) {
    const trace = systemTrace(account.conversationKey);

    try {
      await requestOutcome(
        trace,
        "global",
        EEventType.AppDeviceUnregisterRequested,
        { deviceId, accountId },
        EEventType.AppDeviceUnregistered,
        () => undefined,
        COMMAND_TIMEOUT_MS,
        "Unregistering the device timed out",
      );
    } catch (error) {
      if (!(error instanceof CommandRejectedError && error.errorCode === DEVICE_NOT_FOUND)) {
        throw error;
      }
    }
  }

  return Response.json(body);
}

export async function handleConversationCreate(account: TAccountKeys): Promise<Response> {
  const body: TGatewayConversationCreated = await requestOutcome(
    systemTrace(account.conversationKey),
    account.ownerKey,
    EEventType.ConversationCreateRequested,
    { ownerKey: account.ownerKey },
    EEventType.ConversationCreated,
    ({ conversationKey, createdAt }) => ({ conversationKey, createdAt }),
    COMMAND_TIMEOUT_MS,
    "Creating the chat timed out",
  );

  return Response.json(body);
}

// NOTE: on the chat's lane, behind its running turn. Only a listed plain chat of the account
// reaches the lane; Conversation checks the owner and the kind again in the delete's
// transaction
export async function handleConversationDelete(
  account: TAccountKeys,
  conversationKey: string,
  kind: EConversationKind,
): Promise<Response> {
  if (kind !== EConversationKind.Plain) {
    return errorResponse("Not found", 404, undefined);
  }

  try {
    await requestOutcome(
      systemTrace(conversationKey),
      conversationKey,
      EEventType.ConversationDeleteRequested,
      { conversationKey, ownerKey: account.ownerKey },
      EEventType.ConversationDeleted,
      () => undefined,
      DELETE_TIMEOUT_MS,
      // the command stays queued on the lane
      "The assistant is busy with this chat. The chat is deleted once it finishes.",
    );
  } catch (error) {
    if (error instanceof CommandRejectedError && error.errorCode === CONVERSATION_NOT_FOUND) {
      return errorResponse("Not found", 404, undefined);
    }

    throw error;
  }

  const body: TGatewayConversationDeleted = { conversationKey };

  return Response.json(body);
}

export async function handleMessageDelete(
  account: TAccountKeys,
  messageId: number,
): Promise<Response> {
  const { conversationKey } = account;
  const body: TGatewayMessageDeleted = {
    deletedMessageIds: await requestOutcome(
      systemTrace(conversationKey),
      conversationKey,
      EEventType.ConversationMessageDeleteRequested,
      { chatId: conversationKey, messageId },
      EEventType.ConversationMessageDeleted,
      (outcome) => outcome.messageIds,
      DELETE_TIMEOUT_MS,
      // the command stays queued on the lane
      "The assistant is busy with this chat. The message is deleted once it finishes.",
    ),
  };

  return Response.json(body);
}
