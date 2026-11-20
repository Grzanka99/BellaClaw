import { createHash, timingSafeEqual } from "node:crypto";
import {
  createMessageTurnId,
  createSystemTurnId,
  type TBehaviorTraceContext,
} from "@bellaclaw/behavior-logs";
import { EConversationKind, EEventType, findOwnedConversationKind } from "@bellaclaw/database";
import {
  CONVERSATION_NOT_FOUND,
  DEVICE_NOT_FOUND,
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
  isP256PublicKey,
  MAX_IMAGE_BYTES,
  SGatewayActivationCheckRequest,
  SGatewayAppMessage,
  SGatewayDeviceId,
  SGatewayDeviceRegistration,
  SGatewayLinkRequest,
  SGatewayModelUpdate,
  SGatewayPersonalityUpdate,
  SGatewayPresence,
  type TGatewayAccount,
  type TGatewayActivationCheck,
  type TGatewayAppMessageAccepted,
  type TGatewayChatLink,
  type TGatewayConversationCreated,
  type TGatewayConversationDeleted,
  type TGatewayDevice,
  type TGatewayDevicesRemoved,
  type TGatewayError,
  type TGatewayLinkStarted,
  type TGatewayMedia,
  type TGatewayMessageDeleted,
  type TGatewayModelCatalog,
  type TGatewayModelChoice,
  type TGatewayModelState,
  type TGatewayPersonality,
  type TGatewayPresenceAccepted,
  type TOption,
} from "@bellaclaw/shared";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { z } from "zod";
import { findAiLoginProblem } from "../ai/auth";
import { LlmClient } from "../ai/llm";
import { decodeAiModelPreferences } from "../ai/model-preferences";
import {
  aiModels,
  checkAiModelChoice,
  EAiModelChoiceProblem,
  getAiApiKey,
  getAiModelConfigs,
  refreshAiModels,
  supportsAiServiceTier,
} from "../ai/providers/registry";
import { resolveAiProvider } from "../ai/tools/get-settings";
import {
  prepareAiSettingsUpdate,
  validateAiSettingsArgs,
} from "../ai/tools/update-settings/ai-settings";
import { EAiProvider, EModelPurpose, SAiProvider } from "../ai/types";
import { AppChannel, imageTypeOf } from "../app";
import { sanitizeErrorMessage } from "../app-logger/sanitizers";
import { AppStream } from "../app-stream";
import { AuthorizationService } from "../authorization";
import { DatabaseConnector } from "../database";
import { CommandRejectedError, ESubscriptionMode, EventBus } from "../events";
import type { TEventPayloads, TModelChoice } from "../events/catalog";
import { IdentityService, type TAccountKeys } from "../identity";
import { parseCanonicalChatKey } from "../messaging/chat-key";
import { EMessagePlatform, SUPPORTED_IMAGE_TYPES } from "../messaging/types";
import { SettingsService, type TConfigUpdate } from "../settings";
import { EConfigKey, type TConfigRecord } from "../settings/schema";

const COMMAND_TIMEOUT_MS = 60_000;
// NOTE: a delete waits on the chat's lane behind a running turn and its compaction. Just under
// the gateway's 250 s wait for this API, so the gateway gets the answer.
const DELETE_TIMEOUT_MS = 240_000;

// the shared body, with provider and purpose narrowed to the assistant's enums
const SModelUpdate = SGatewayModelUpdate.extend({
  aiProvider: SAiProvider.optional(),
  aiModelPurpose: z.enum(EModelPurpose).optional(),
});

// every body but an image upload is a small JSON object
const MAX_JSON_BODY_BYTES = 65_536;

// NOTE: well under both servers' 255 s idle timeout, so an idle stream stays open
const STREAM_KEEP_ALIVE_MS = 25_000;

// commands waiting for their outcome, by the turn id of the command
const pendingUpdates = new Map<string, PromiseWithResolvers<TConfigRecord>>();
const pendingDeletes = new Map<string, PromiseWithResolvers<number[]>>();
const pendingLinks = new Map<string, PromiseWithResolvers<void>>();
const pendingCreates = new Map<string, PromiseWithResolvers<TGatewayConversationCreated>>();
const pendingConversationDeletes = new Map<string, PromiseWithResolvers<void>>();
const pendingDeviceRegistrations = new Map<string, PromiseWithResolvers<void>>();
const pendingDeviceUnregistrations = new Map<string, PromiseWithResolvers<void>>();
let server: TOption<ReturnType<typeof Bun.serve>>;

// NOTE: a request is no bus handler, so it has no ctx.request. It publishes the command under a
// turn id of its own and these live subscriptions settle it: the outcome inherits the trace.
export function setupInternalApi(): void {
  const bus = EventBus.instance;

  bus.subscribe({
    consumer: "internal-api",
    type: EEventType.SettingsChanged,
    mode: ESubscriptionMode.Live,
    backoffMs: [],
    handler: async (event) => {
      pendingUpdates.get(event.trace.turnId)?.resolve(event.payload.record);
    },
  });
  bus.subscribe({
    consumer: "internal-api",
    type: EEventType.ConversationMessageDeleted,
    mode: ESubscriptionMode.Live,
    backoffMs: [],
    handler: async (event) => {
      pendingDeletes.get(event.trace.turnId)?.resolve(event.payload.messageIds);
    },
  });
  bus.subscribe({
    consumer: "internal-api",
    type: EEventType.IdentityLinkStarted,
    mode: ESubscriptionMode.Live,
    backoffMs: [],
    handler: async (event) => {
      pendingLinks.get(event.trace.turnId)?.resolve();
    },
  });
  bus.subscribe({
    consumer: "internal-api",
    type: EEventType.ConversationCreated,
    mode: ESubscriptionMode.Live,
    backoffMs: [],
    handler: async (event) => {
      const { conversationKey, createdAt } = event.payload;
      pendingCreates.get(event.trace.turnId)?.resolve({ conversationKey, createdAt });
    },
  });
  bus.subscribe({
    consumer: "internal-api",
    type: EEventType.ConversationDeleted,
    mode: ESubscriptionMode.Live,
    backoffMs: [],
    handler: async (event) => {
      pendingConversationDeletes.get(event.trace.turnId)?.resolve();
    },
  });
  bus.subscribe({
    consumer: "internal-api",
    type: EEventType.AppDeviceRegistered,
    mode: ESubscriptionMode.Live,
    backoffMs: [],
    handler: async (event) => {
      pendingDeviceRegistrations.get(event.trace.turnId)?.resolve();
    },
  });
  bus.subscribe({
    consumer: "internal-api",
    type: EEventType.AppDeviceUnregistered,
    mode: ESubscriptionMode.Live,
    backoffMs: [],
    handler: async (event) => {
      pendingDeviceUnregistrations.get(event.trace.turnId)?.resolve();
    },
  });
  bus.subscribe({
    consumer: "internal-api",
    type: EEventType.CommandRejected,
    mode: ESubscriptionMode.Live,
    backoffMs: [],
    handler: async (event) => {
      const { code, message, errorCode } = event.payload;
      const error = new CommandRejectedError(code, message, errorCode);
      pendingUpdates.get(event.trace.turnId)?.reject(error);
      pendingDeletes.get(event.trace.turnId)?.reject(error);
      pendingLinks.get(event.trace.turnId)?.reject(error);
      pendingCreates.get(event.trace.turnId)?.reject(error);
      pendingConversationDeletes.get(event.trace.turnId)?.reject(error);
      pendingDeviceRegistrations.get(event.trace.turnId)?.reject(error);
      pendingDeviceUnregistrations.get(event.trace.turnId)?.reject(error);
    },
  });
}

// publishes a command on the key's lane and waits for the outcome the live subscriptions settle
async function requestOutcome<T extends EEventType, R>(
  pending: Map<string, PromiseWithResolvers<R>>,
  trace: TBehaviorTraceContext,
  key: string,
  type: T,
  payload: TEventPayloads[T],
  timeoutMs: number,
  timeoutMessage: string,
): Promise<R> {
  const outcome = Promise.withResolvers<R>();
  pending.set(trace.turnId, outcome);
  const timer = setTimeout(() => {
    outcome.reject(new Error(timeoutMessage));
  }, timeoutMs);

  try {
    const [result] = await Promise.all([
      outcome.promise,
      EventBus.instance.publish({
        type,
        source: "internal-api",
        key,
        trace,
        payload,
        causationId: undefined,
        dedupeKey: undefined,
      }),
    ]);

    return result;
  } finally {
    clearTimeout(timer);
    pending.delete(trace.turnId);
  }
}

// every issue of a refused body with its path, for the 400's message
function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => [...issue.path, issue.message].join(": ")).join(", ");
}

// the trace of a command the API publishes for a chat
function systemTrace(chatId: string): TBehaviorTraceContext {
  return { turnId: createSystemTurnId(), chatId, platform: undefined };
}

function createModelState(settings: TConfigRecord): TGatewayModelState {
  const provider = resolveAiProvider(settings);
  const models = getAiModelConfigs(
    provider,
    decodeAiModelPreferences(settings[EConfigKey.AiModelPreferences]),
  );

  return {
    provider,
    providers: Object.values(EAiProvider),
    purposes: Object.values(EModelPurpose).map((purpose) => ({ purpose, ...models[purpose] })),
    availableModels: aiModels.getModels(provider).map((model) => ({
      id: model.id,
      name: model.name,
      supportedEfforts: getSupportedThinkingLevels(model),
      supportsServiceTier: supportsAiServiceTier(model),
    })),
  };
}

// every provider with its models, and why a send cannot use it now. A catalog that loads over the
// network is refreshed only for a provider that can be used
async function createModelCatalog(): Promise<TGatewayModelCatalog> {
  const providers: TGatewayModelCatalog["providers"] = [];

  for (const provider of Object.values(EAiProvider)) {
    const reason = await findProviderProblem(provider);

    if (reason === undefined) {
      await refreshAiModels(provider);
    }

    providers.push({
      id: provider,
      usable: reason === undefined,
      reason,
      models: aiModels.getModels(provider).map((model) => ({
        id: model.id,
        name: model.name,
        supportedEfforts: getSupportedThinkingLevels(model),
      })),
    });
  }

  return { providers };
}

// the same checks, verification and settings.update.requested command as the update-settings tool.
// The trace names the account's Bella conversation.
async function updateModel(
  { ownerKey, conversationKey }: TAccountKeys,
  body: unknown,
): Promise<TConfigRecord> {
  const args = SModelUpdate.safeParse(body);

  if (!args.success) {
    throw new Error(describeIssues(args.error));
  }

  const trace = systemTrace(conversationKey);
  const updates: TConfigUpdate[] = [];
  const { settings } = await prepareAiSettingsUpdate(
    ownerKey,
    args.data,
    validateAiSettingsArgs(args.data),
    updates,
    (nextSettings, purposes) => LlmClient.instance.verifySettings(nextSettings, purposes, trace),
  );

  if (updates.length === 0) {
    return settings;
  }

  return requestOutcome(
    pendingUpdates,
    trace,
    ownerKey,
    EEventType.SettingsUpdateRequested,
    { ownerKey, updates },
    COMMAND_TIMEOUT_MS,
    "Settings update timed out",
  );
}

function createPersonality(settings: TConfigRecord): TGatewayPersonality {
  return {
    bellaPersona: settings[EConfigKey.AiInstructionsPersona],
    plainChatsUseBellaPersona: settings[EConfigKey.AiPlainChatsUseBellaPersona] === "true",
    plainChatsPersona: settings[EConfigKey.AiPlainChatsPersona],
  };
}

// the settings.update.requested command a change in chat makes, so Settings validates the values
// the same way: a blank Bella persona or no field at all is refused. The trace names the account's
// Bella conversation
async function updatePersonality(
  { ownerKey, conversationKey }: TAccountKeys,
  body: unknown,
): Promise<TConfigRecord> {
  const update = SGatewayPersonalityUpdate.safeParse(body);

  if (!update.success) {
    throw new Error(describeIssues(update.error));
  }

  const updates: TConfigUpdate[] = [];

  if (update.data.bellaPersona !== undefined) {
    updates.push({ key: EConfigKey.AiInstructionsPersona, value: update.data.bellaPersona });
  }

  if (update.data.plainChatsUseBellaPersona !== undefined) {
    updates.push({
      key: EConfigKey.AiPlainChatsUseBellaPersona,
      value: String(update.data.plainChatsUseBellaPersona),
    });
  }

  if (update.data.plainChatsPersona !== undefined) {
    updates.push({ key: EConfigKey.AiPlainChatsPersona, value: update.data.plainChatsPersona });
  }

  return requestOutcome(
    pendingUpdates,
    systemTrace(conversationKey),
    ownerKey,
    EEventType.SettingsUpdateRequested,
    { ownerKey, updates },
    COMMAND_TIMEOUT_MS,
    "Settings update timed out",
  );
}

// why the provider cannot be used now: its API key is missing, or its OAuth login is not connected
// or expired
async function findProviderProblem(provider: EAiProvider): Promise<TOption<string>> {
  try {
    getAiApiKey(provider);
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  return findAiLoginProblem(provider);
}

// A plain chat's model as the app chose it, checked against what the server offers: a provider of
// its own that is usable now (its API key is set, its OAuth login is connected), a model that
// provider lists, an effort the model supports
async function checkModelChoice(choice: TGatewayModelChoice): Promise<TModelChoice> {
  const provider = SAiProvider.safeParse(choice.provider);

  if (!provider.success) {
    throw new Error(`Unknown AI provider: ${choice.provider}`);
  }

  const providerProblem = await findProviderProblem(provider.data);

  if (providerProblem !== undefined) {
    throw new Error(providerProblem);
  }

  const problem = await checkAiModelChoice(provider.data, choice.model, choice.effort);

  if (problem === EAiModelChoiceProblem.ModelUnavailable) {
    throw new Error(`Model "${choice.model}" is not available from provider "${provider.data}"`);
  }

  if (problem === EAiModelChoiceProblem.EffortUnsupported) {
    throw new Error(`Effort ${choice.effort} is unsupported by ${choice.model}`);
  }

  return { provider: provider.data, model: choice.model, effort: choice.effort };
}

// publishes identity.link.requested and answers once the cutover began; it does not wait for
// identity.linked
async function requestLink(body: unknown): Promise<TGatewayLinkStarted> {
  const request = SGatewayLinkRequest.safeParse(body);

  if (!request.success) {
    throw new Error("Invalid link request");
  }

  const { accountId, chatKey } = request.data;
  const address = parseCanonicalChatKey(chatKey);

  if (address === undefined) {
    throw new Error("Invalid chat key");
  }

  await requestOutcome(
    pendingLinks,
    systemTrace(chatKey),
    chatKey,
    EEventType.IdentityLinkRequested,
    { accountId, channel: address.platform, address: address.chatId },
    COMMAND_TIMEOUT_MS,
    "Link request timed out",
  );

  return { state: "migrating" };
}

// The edge's one live stream for every account: each event of the app stream as a line of JSON,
// and an empty line as a keep-alive. Closing the connection releases the listener and the timer,
// and ends the presence the edge reported while it was open
function openStream(request: Request): Response {
  const encoder = new TextEncoder();
  let release = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = AppStream.instance.listen((event) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      });
      const endPresence = AppChannel.instance.openEdgeConnection();
      const keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode("\n"));
      }, STREAM_KEEP_ALIVE_MS);
      release = () => {
        clearInterval(keepAlive);
        close();
        endPresence();
      };
      request.signal.addEventListener("abort", release, { once: true });
      // the first line sends the response's headers, so the edge sees the stream open at once
      controller.enqueue(encoder.encode("\n"));
    },
    cancel() {
      release();
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}

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

function errorResponse(error: string, status: number, code: TOption<string>): Response {
  const body: TGatewayError = { error, code };

  return Response.json(body, { status });
}

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
  let conversationKey = "";
  let mediaId = "";

  try {
    key = decodeURIComponent(segments[3] ?? "");
    conversationKey = decodeURIComponent(segments[5] ?? "");
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
    conversationKey.length > 0 &&
    pathname === gatewayAccountConversationMessagesPath(key, conversationKey);
  const conversationCreateRoute =
    request.method === "POST" &&
    key.length > 0 &&
    pathname === gatewayAccountConversationsPath(key);
  const conversationDeleteRoute =
    request.method === "DELETE" &&
    key.length > 0 &&
    conversationKey.length > 0 &&
    pathname === gatewayAccountConversationPath(key, conversationKey);

  const mediaUploadRoute =
    request.method === "POST" &&
    key.length > 0 &&
    conversationKey.length > 0 &&
    pathname === gatewayAccountConversationMediaPath(key, conversationKey);
  const mediaDownloadRoute =
    request.method === "GET" &&
    key.length > 0 &&
    conversationKey.length > 0 &&
    mediaId.length > 0 &&
    pathname === gatewayAccountConversationMediaFilePath(key, conversationKey, mediaId);
  // segment 5 is the device id here
  const deviceRoute =
    (request.method === "PUT" || request.method === "DELETE") &&
    key.length > 0 &&
    conversationKey.length > 0 &&
    pathname === gatewayAccountDevicePath(key, conversationKey);
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
    // a read: checking a code changes nothing, so no command is published
    if (activationRoute) {
      const check = SGatewayActivationCheckRequest.safeParse(await request.json());

      if (!check.success) {
        throw new Error("Invalid activation code check");
      }

      const matches = AuthorizationService.instance.matchesActivationToken(check.data.code);
      const body: TGatewayActivationCheck = { result: "unset" };

      if (matches === true) {
        body.result = "valid";
      } else if (matches === false) {
        body.result = "invalid";
      }

      return Response.json(body);
    }

    if (streamRoute) {
      return openStream(request);
    }

    if (presenceRoute) {
      const presence = SGatewayPresence.safeParse(await request.json());

      if (!presence.success) {
        throw new Error("Invalid presence");
      }

      AppChannel.instance.reportPresence(presence.data.accountIds);
      const body: TGatewayPresenceAccepted = { ok: true };

      return Response.json(body);
    }

    if (linkRequestRoute) {
      return Response.json(await requestLink(await request.json()));
    }

    if (chatLinkRoute) {
      const link = await IdentityService.instance.link(key);
      const body: TGatewayChatLink = { link: undefined };

      if (link !== undefined) {
        body.link = { accountId: link.accountId, state: link.state };
      }

      return Response.json(body);
    }

    const account = await IdentityService.instance.account(key);

    if (accountRoute) {
      const body: TGatewayAccount = {
        conversationKey: account.conversationKey,
        ownerKey: account.ownerKey,
        links: account.links.map((link) => ({
          chatKey: IdentityService.instance.addressKey(link),
          state: link.state,
          linkedAt: link.linkedAt.getTime(),
        })),
      };

      return Response.json(body);
    }

    // a conversation route answers 404 for a conversation that is not the account's
    let kind: TOption<EConversationKind>;

    if (appMessageRoute || mediaUploadRoute || mediaDownloadRoute || conversationDeleteRoute) {
      kind = await DatabaseConnector.instance.run((db) =>
        findOwnedConversationKind(db, conversationKey, account),
      );

      if (kind === undefined) {
        return errorResponse("Not found", 404, undefined);
      }
    }

    // NOTE: the send answers once message.received is stored and waits for no outcome. The client's
    // id is the dedupe key, so a repeated send stores nothing and answers the same. Authorization
    // checks the ownership again before the message reaches a turn. A plain chat's send carries
    // its model, checked here; the Bella conversation runs on the account's settings
    if (appMessageRoute) {
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
        AppChannel.instance.findAttachments(db, key, conversationKey, images),
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
          replyAddress: key,
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
    if (mediaUploadRoute) {
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
        key,
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

    // 404 for a conversation that is not the account's, 410 for an image this conversation does not
    // keep
    if (mediaDownloadRoute) {
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
    if (deviceRoute) {
      const deviceId = SGatewayDeviceId.safeParse(conversationKey);

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
          pendingDeviceRegistrations,
          trace,
          "global",
          EEventType.AppDeviceRegisterRequested,
          { deviceId: deviceId.data, accountId: key, ...registration.data },
          COMMAND_TIMEOUT_MS,
          "Registering the device timed out",
        );

        return Response.json(body);
      }

      try {
        await requestOutcome(
          pendingDeviceUnregistrations,
          trace,
          "global",
          EEventType.AppDeviceUnregisterRequested,
          { deviceId: deviceId.data, accountId: key },
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
    if (accountDevicesRoute) {
      const body: TGatewayDevicesRemoved = {
        deviceIds: await AppChannel.instance.listDeviceIds(key),
      };

      for (const deviceId of body.deviceIds) {
        const trace = systemTrace(account.conversationKey);

        try {
          await requestOutcome(
            pendingDeviceUnregistrations,
            trace,
            "global",
            EEventType.AppDeviceUnregisterRequested,
            { deviceId, accountId: key },
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

    if (conversationCreateRoute) {
      const body: TGatewayConversationCreated = await requestOutcome(
        pendingCreates,
        systemTrace(account.conversationKey),
        account.ownerKey,
        EEventType.ConversationCreateRequested,
        { ownerKey: account.ownerKey },
        COMMAND_TIMEOUT_MS,
        "Creating the chat timed out",
      );

      return Response.json(body);
    }

    // NOTE: on the chat's lane, behind its running turn. Only a listed plain chat of the account
    // reaches the lane; Conversation checks the owner and the kind again in the delete's
    // transaction
    if (conversationDeleteRoute) {
      if (kind !== EConversationKind.Plain) {
        return errorResponse("Not found", 404, undefined);
      }

      try {
        await requestOutcome(
          pendingConversationDeletes,
          systemTrace(conversationKey),
          conversationKey,
          EEventType.ConversationDeleteRequested,
          { conversationKey, ownerKey: account.ownerKey },
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

    if (messageDeleteRoute) {
      const { conversationKey } = account;
      const body: TGatewayMessageDeleted = {
        deletedMessageIds: await requestOutcome(
          pendingDeletes,
          systemTrace(conversationKey),
          conversationKey,
          EEventType.ConversationMessageDeleteRequested,
          { chatId: conversationKey, messageId },
          DELETE_TIMEOUT_MS,
          // the command stays queued on the lane
          "The assistant is busy with this chat. The message is deleted once it finishes.",
        ),
      };

      return Response.json(body);
    }

    if (modelsRoute) {
      return Response.json(await createModelCatalog());
    }

    if (personalityRoute) {
      let settings: TConfigRecord;

      if (request.method === "PUT") {
        settings = await updatePersonality(account, await request.json());
      } else {
        settings = await SettingsService.instance.getAll(account.ownerKey);
      }

      return Response.json(createPersonality(settings));
    }

    if (request.method === "PUT") {
      return Response.json(createModelState(await updateModel(account, await request.json())));
    }

    const settings = await SettingsService.instance.getAll(account.ownerKey);
    await refreshAiModels(resolveAiProvider(settings), true);

    return Response.json(createModelState(settings));
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
