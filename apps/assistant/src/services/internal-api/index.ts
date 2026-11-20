import { createHash, timingSafeEqual } from "node:crypto";
import {
  createMessageTurnId,
  createSystemTurnId,
  type TBehaviorTraceContext,
} from "@bellaclaw/behavior-logs";
import {
  EConversationKind,
  EEventType,
  findConversationKind,
  findOwnedConversation,
} from "@bellaclaw/database";
import {
  CONVERSATION_NOT_FOUND,
  DASHBOARD_ACTIVATION_CHECK_PATH,
  DASHBOARD_LINKS_PATH,
  DASHBOARD_PRESENCE_PATH,
  DASHBOARD_STREAM_PATH,
  DEVICE_NOT_FOUND,
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
  isP256PublicKey,
  MAX_IMAGE_BYTES,
  SDashboardActivationCheckRequest,
  SDashboardAppMessage,
  SDashboardDeviceId,
  SDashboardDeviceRegistration,
  SDashboardLinkRequest,
  SDashboardModelUpdate,
  SDashboardPersonalityUpdate,
  SDashboardPresence,
  type TDashboardAccount,
  type TDashboardActivationCheck,
  type TDashboardAppMessageAccepted,
  type TDashboardChatLink,
  type TDashboardConversationCreated,
  type TDashboardConversationDeleted,
  type TDashboardDevice,
  type TDashboardDevicesRemoved,
  type TDashboardError,
  type TDashboardLinkStarted,
  type TDashboardMedia,
  type TDashboardMessageDeleted,
  type TDashboardModelChoice,
  type TDashboardModelState,
  type TDashboardPersonality,
  type TDashboardPresenceAccepted,
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
// the dashboard's 250 s wait for this API, so the dashboard gets the answer.
const DELETE_TIMEOUT_MS = 240_000;

// the shared body, with provider and purpose narrowed to the assistant's enums
const SModelUpdate = SDashboardModelUpdate.extend({
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
const pendingCreates = new Map<string, PromiseWithResolvers<TDashboardConversationCreated>>();
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

function createModelState(settings: TConfigRecord): TDashboardModelState {
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

// the same checks, verification and settings.update.requested command as the update-settings tool.
// The trace names the account's Bella conversation.
async function updateModel(
  { ownerKey, conversationKey }: TAccountKeys,
  body: unknown,
): Promise<TConfigRecord> {
  const args = SModelUpdate.safeParse(body);

  if (!args.success) {
    throw new Error(
      args.error.issues.map((issue) => [...issue.path, issue.message].join(": ")).join(", "),
    );
  }

  const trace = { turnId: createSystemTurnId(), chatId: conversationKey, platform: undefined };
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

function createPersonality(settings: TConfigRecord): TDashboardPersonality {
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
  const update = SDashboardPersonalityUpdate.safeParse(body);

  if (!update.success) {
    throw new Error(
      update.error.issues.map((issue) => [...issue.path, issue.message].join(": ")).join(", "),
    );
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
    { turnId: createSystemTurnId(), chatId: conversationKey, platform: undefined },
    ownerKey,
    EEventType.SettingsUpdateRequested,
    { ownerKey, updates },
    COMMAND_TIMEOUT_MS,
    "Settings update timed out",
  );
}

// A plain chat's model as the app chose it, checked against what the server offers: a provider of
// its own that is usable now (its API key is set, its OAuth login is connected), a model that
// provider lists, an effort the model supports
async function checkModelChoice(choice: TDashboardModelChoice): Promise<TModelChoice> {
  const provider = SAiProvider.safeParse(choice.provider);

  if (!provider.success) {
    throw new Error(`Unknown AI provider: ${choice.provider}`);
  }

  // throws for a provider whose API key is missing
  getAiApiKey(provider.data);
  const loginProblem = await findAiLoginProblem(provider.data);

  if (loginProblem !== undefined) {
    throw new Error(loginProblem);
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
async function requestLink(body: unknown): Promise<TDashboardLinkStarted> {
  const request = SDashboardLinkRequest.safeParse(body);

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
    { turnId: createSystemTurnId(), chatId: chatKey, platform: undefined },
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
  const body: TDashboardError = { error, code };

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

  const activationRoute = request.method === "POST" && pathname === DASHBOARD_ACTIVATION_CHECK_PATH;
  const linkRequestRoute = request.method === "POST" && pathname === DASHBOARD_LINKS_PATH;
  const streamRoute = request.method === "GET" && pathname === DASHBOARD_STREAM_PATH;
  const presenceRoute = request.method === "POST" && pathname === DASHBOARD_PRESENCE_PATH;
  const chatLinkRoute =
    request.method === "GET" && key.length > 0 && pathname === dashboardChatLinkPath(key);
  const accountRoute =
    request.method === "GET" && key.length > 0 && pathname === dashboardAccountPath(key);
  const modelRoute =
    key.length > 0 &&
    pathname === dashboardAccountModelPath(key) &&
    (request.method === "GET" || request.method === "PUT");
  const personalityRoute =
    key.length > 0 &&
    pathname === dashboardAccountPersonalityPath(key) &&
    (request.method === "GET" || request.method === "PUT");
  const messageDeleteRoute =
    request.method === "DELETE" &&
    key.length > 0 &&
    Number.isSafeInteger(messageId) &&
    pathname === dashboardAccountMessagePath(key, messageId);
  const appMessageRoute =
    request.method === "POST" &&
    key.length > 0 &&
    conversationKey.length > 0 &&
    pathname === dashboardAccountConversationMessagesPath(key, conversationKey);
  const conversationCreateRoute =
    request.method === "POST" &&
    key.length > 0 &&
    pathname === dashboardAccountConversationsPath(key);
  const conversationDeleteRoute =
    request.method === "DELETE" &&
    key.length > 0 &&
    conversationKey.length > 0 &&
    pathname === dashboardAccountConversationPath(key, conversationKey);

  const mediaUploadRoute =
    request.method === "POST" &&
    key.length > 0 &&
    conversationKey.length > 0 &&
    pathname === dashboardAccountConversationMediaPath(key, conversationKey);
  const mediaDownloadRoute =
    request.method === "GET" &&
    key.length > 0 &&
    conversationKey.length > 0 &&
    mediaId.length > 0 &&
    pathname === dashboardAccountConversationMediaFilePath(key, conversationKey, mediaId);
  // segment 5 is the device id here
  const deviceRoute =
    (request.method === "PUT" || request.method === "DELETE") &&
    key.length > 0 &&
    conversationKey.length > 0 &&
    pathname === dashboardAccountDevicePath(key, conversationKey);
  const accountDevicesRoute =
    request.method === "DELETE" && key.length > 0 && pathname === dashboardAccountDevicesPath(key);

  if (
    !activationRoute &&
    !linkRequestRoute &&
    !streamRoute &&
    !presenceRoute &&
    !chatLinkRoute &&
    !accountRoute &&
    !modelRoute &&
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
      const check = SDashboardActivationCheckRequest.safeParse(await request.json());

      if (!check.success) {
        throw new Error("Invalid activation code check");
      }

      const matches = AuthorizationService.instance.matchesActivationToken(check.data.code);
      const body: TDashboardActivationCheck = { result: "unset" };

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
      const presence = SDashboardPresence.safeParse(await request.json());

      if (!presence.success) {
        throw new Error("Invalid presence");
      }

      AppChannel.instance.reportPresence(presence.data.accountIds);
      const body: TDashboardPresenceAccepted = { ok: true };

      return Response.json(body);
    }

    if (linkRequestRoute) {
      return Response.json(await requestLink(await request.json()));
    }

    if (chatLinkRoute) {
      const link = await IdentityService.instance.link(key);
      const body: TDashboardChatLink = { link: undefined };

      if (link !== undefined) {
        body.link = { accountId: link.accountId, state: link.state };
      }

      return Response.json(body);
    }

    const account = await IdentityService.instance.account(key);

    if (accountRoute) {
      const body: TDashboardAccount = {
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

    // NOTE: the send answers once message.received is stored and waits for no outcome. The client's
    // id is the dedupe key, so a repeated send stores nothing and answers the same. Authorization
    // checks the ownership again before the message reaches a turn. A plain chat's send carries
    // its model, checked here; the Bella conversation runs on the account's settings
    if (appMessageRoute) {
      const kind = await DatabaseConnector.instance.run(async (db) => {
        if ((await findOwnedConversation(db, conversationKey, account)) === undefined) {
          return undefined;
        }

        return findConversationKind(db, conversationKey);
      });

      if (kind === undefined) {
        return errorResponse("Not found", 404, undefined);
      }

      const message = SDashboardAppMessage.safeParse(await request.json());

      if (!message.success) {
        throw new Error(message.error.issues[0]?.message ?? "Invalid message");
      }

      const { clientMessageId, text, images = [] } = message.data;
      const dedupeKey = `app:${conversationKey}:${clientMessageId}`;
      const body: TDashboardAppMessageAccepted = { clientMessageId };

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
      const owned = await DatabaseConnector.instance.run((db) =>
        findOwnedConversation(db, conversationKey, account),
      );

      if (owned === undefined) {
        return errorResponse("Not found", 404, undefined);
      }

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

      const body: TOption<TDashboardMedia> = await AppChannel.instance.store(
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
      const owned = await DatabaseConnector.instance.run((db) =>
        findOwnedConversation(db, conversationKey, account),
      );

      if (owned === undefined) {
        return errorResponse("Not found", 404, undefined);
      }

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
      const deviceId = SDashboardDeviceId.safeParse(conversationKey);

      if (!deviceId.success) {
        throw new Error("Invalid device id");
      }

      const trace = {
        turnId: createSystemTurnId(),
        chatId: account.conversationKey,
        platform: undefined,
      };
      const body: TDashboardDevice = { deviceId: deviceId.data };

      if (request.method === "PUT") {
        const registration = SDashboardDeviceRegistration.safeParse(await request.json());

        if (!registration.success) {
          throw new Error(registration.error.issues[0]?.message ?? "Invalid device");
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
      const body: TDashboardDevicesRemoved = {
        deviceIds: await AppChannel.instance.listDeviceIds(key),
      };

      for (const deviceId of body.deviceIds) {
        const trace = {
          turnId: createSystemTurnId(),
          chatId: account.conversationKey,
          platform: undefined,
        };

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
      const body: TDashboardConversationCreated = await requestOutcome(
        pendingCreates,
        { turnId: createSystemTurnId(), chatId: account.conversationKey, platform: undefined },
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
      const kind = await DatabaseConnector.instance.run(async (db) => {
        if ((await findOwnedConversation(db, conversationKey, account)) === undefined) {
          return undefined;
        }

        return findConversationKind(db, conversationKey);
      });

      if (kind !== EConversationKind.Plain) {
        return errorResponse("Not found", 404, undefined);
      }

      try {
        await requestOutcome(
          pendingConversationDeletes,
          { turnId: createSystemTurnId(), chatId: conversationKey, platform: undefined },
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

      const body: TDashboardConversationDeleted = { conversationKey };

      return Response.json(body);
    }

    if (messageDeleteRoute) {
      const { conversationKey } = account;
      const body: TDashboardMessageDeleted = {
        deletedMessageIds: await requestOutcome(
          pendingDeletes,
          { turnId: createSystemTurnId(), chatId: conversationKey, platform: undefined },
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

// starts only when BELLACLAW_DASHBOARD_SECRET is set
export function startInternalApiServer(): void {
  const secret = Bun.env.BELLACLAW_DASHBOARD_SECRET?.trim();

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
    // an image upload; every other body is held to MAX_JSON_BODY_BYTES by its route
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
