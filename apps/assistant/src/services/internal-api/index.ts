import { createHash, timingSafeEqual } from "node:crypto";
import { createSystemTurnId, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import { EEventType } from "@bellaclaw/database";
import {
  DASHBOARD_ACTIVATION_CHECK_PATH,
  DASHBOARD_LINKS_PATH,
  dashboardAccountMessagePath,
  dashboardAccountModelPath,
  dashboardAccountPath,
  dashboardChatLinkPath,
  SDashboardActivationCheckRequest,
  SDashboardLinkRequest,
  SDashboardModelUpdate,
  type TDashboardAccount,
  type TDashboardActivationCheck,
  type TDashboardChatLink,
  type TDashboardError,
  type TDashboardLinkStarted,
  type TDashboardMessageDeleted,
  type TDashboardModelState,
  type TOption,
} from "@bellaclaw/shared";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { z } from "zod";
import { LlmClient } from "../ai/llm";
import { decodeAiModelPreferences } from "../ai/model-preferences";
import {
  aiModels,
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
import { sanitizeErrorMessage } from "../app-logger/sanitizers";
import { AuthorizationService } from "../authorization";
import { CommandRejectedError, ESubscriptionMode, EventBus } from "../events";
import type { TEventPayloads } from "../events/catalog";
import { IdentityService, type TAccountKeys } from "../identity";
import { parseCanonicalChatKey } from "../messaging/chat-key";
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

// commands waiting for their outcome, by the turn id of the command
const pendingUpdates = new Map<string, PromiseWithResolvers<TConfigRecord>>();
const pendingDeletes = new Map<string, PromiseWithResolvers<number[]>>();
const pendingLinks = new Map<string, PromiseWithResolvers<void>>();
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
    type: EEventType.CommandRejected,
    mode: ESubscriptionMode.Live,
    backoffMs: [],
    handler: async (event) => {
      const { code, message, errorCode } = event.payload;
      const error = new CommandRejectedError(code, message, errorCode);
      pendingUpdates.get(event.trace.turnId)?.reject(error);
      pendingDeletes.get(event.trace.turnId)?.reject(error);
      pendingLinks.get(event.trace.turnId)?.reject(error);
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
  // ["", "internal", "activation-code", "check"], ["", "internal", "links"],
  // ["", "internal", "links", chatKey],
  // ["", "internal", "accounts", accountId], ["", "internal", "accounts", accountId, "model"] or
  // ["", "internal", "accounts", accountId, "messages", messageId]
  const segments = pathname.split("/");
  const messageId = Number(segments[5]);
  let key = "";

  try {
    key = decodeURIComponent(segments[3] ?? "");
  } catch {
    // a malformed escape is an unknown route
  }

  const activationRoute = request.method === "POST" && pathname === DASHBOARD_ACTIVATION_CHECK_PATH;
  const linkRequestRoute = request.method === "POST" && pathname === DASHBOARD_LINKS_PATH;
  const chatLinkRoute =
    request.method === "GET" && key.length > 0 && pathname === dashboardChatLinkPath(key);
  const accountRoute =
    request.method === "GET" && key.length > 0 && pathname === dashboardAccountPath(key);
  const modelRoute =
    key.length > 0 &&
    pathname === dashboardAccountModelPath(key) &&
    (request.method === "GET" || request.method === "PUT");
  const messageDeleteRoute =
    request.method === "DELETE" &&
    key.length > 0 &&
    Number.isSafeInteger(messageId) &&
    pathname === dashboardAccountMessagePath(key, messageId);

  if (
    !activationRoute &&
    !linkRequestRoute &&
    !chatLinkRoute &&
    !accountRoute &&
    !modelRoute &&
    !messageDeleteRoute
  ) {
    return errorResponse("Not found", 404, undefined);
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
    // every request body is a small JSON object
    maxRequestBodySize: 65_536,
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
