import { createHash, timingSafeEqual } from "node:crypto";
import { createSystemTurnId, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import { EEventType } from "@bellaclaw/database";
import {
  dashboardChatMessagePath,
  dashboardChatModelPath,
  SDashboardModelUpdate,
  type TDashboardError,
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
import { ESubscriptionMode, EventBus } from "../events";
import type { TEventPayloads } from "../events/catalog";
import { SettingsService, type TConfigUpdate } from "../settings";
import { EConfigKey, type TConfigRecord } from "../settings/schema";

const COMMAND_TIMEOUT_MS = 60_000;

// the shared body, with provider and purpose narrowed to the assistant's enums
const SModelUpdate = SDashboardModelUpdate.extend({
  aiProvider: SAiProvider.optional(),
  aiModelPurpose: z.enum(EModelPurpose).optional(),
});

// commands waiting for their outcome, by the turn id of the command
const pendingUpdates = new Map<string, PromiseWithResolvers<TConfigRecord>>();
const pendingDeletes = new Map<string, PromiseWithResolvers<number[]>>();
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
    type: EEventType.CommandRejected,
    mode: ESubscriptionMode.Live,
    backoffMs: [],
    handler: async (event) => {
      const error = new Error(event.payload.message);
      pendingUpdates.get(event.trace.turnId)?.reject(error);
      pendingDeletes.get(event.trace.turnId)?.reject(error);
    },
  });
}

// publishes a command on the chat's lane and waits for the outcome the live subscriptions settle
async function requestOutcome<T extends EEventType, R>(
  pending: Map<string, PromiseWithResolvers<R>>,
  trace: TBehaviorTraceContext,
  chatId: string,
  type: T,
  payload: TEventPayloads[T],
  timeoutMessage: string,
): Promise<R> {
  const outcome = Promise.withResolvers<R>();
  pending.set(trace.turnId, outcome);
  const timer = setTimeout(() => {
    outcome.reject(new Error(timeoutMessage));
  }, COMMAND_TIMEOUT_MS);

  try {
    const [result] = await Promise.all([
      outcome.promise,
      EventBus.instance.publish({
        type,
        source: "internal-api",
        key: chatId,
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

// the same checks, verification and settings.update.requested command as the update-settings tool
async function updateModel(chatId: string, body: unknown): Promise<TConfigRecord> {
  const args = SModelUpdate.safeParse(body);

  if (!args.success) {
    throw new Error(
      args.error.issues.map((issue) => [...issue.path, issue.message].join(": ")).join(", "),
    );
  }

  const trace = { turnId: createSystemTurnId(), chatId, platform: undefined };
  const updates: TConfigUpdate[] = [];
  const { settings } = await prepareAiSettingsUpdate(
    chatId,
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
    chatId,
    EEventType.SettingsUpdateRequested,
    { ownerKey: chatId, updates },
    "Settings update timed out",
  );
}

function errorResponse(error: string, status: number): Response {
  const body: TDashboardError = { error };

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
    return errorResponse("Unauthorized", 401);
  }

  const { pathname } = new URL(request.url);
  // ["", "internal", "chats", chatId, "model"] or
  // ["", "internal", "chats", chatId, "messages", messageId]
  const segments = pathname.split("/");
  const messageId = Number(segments[5]);
  let chatId = "";

  try {
    chatId = decodeURIComponent(segments[3] ?? "");
  } catch {
    // a malformed escape is an unknown route
  }

  const modelRoute =
    pathname === dashboardChatModelPath(chatId) &&
    (request.method === "GET" || request.method === "PUT");
  const messageDeleteRoute =
    request.method === "DELETE" &&
    Number.isSafeInteger(messageId) &&
    pathname === dashboardChatMessagePath(chatId, messageId);

  if (chatId.length === 0 || (!modelRoute && !messageDeleteRoute)) {
    return errorResponse("Not found", 404);
  }

  try {
    if (messageDeleteRoute) {
      const body: TDashboardMessageDeleted = {
        deletedMessageIds: await requestOutcome(
          pendingDeletes,
          { turnId: createSystemTurnId(), chatId, platform: undefined },
          chatId,
          EEventType.ConversationMessageDeleteRequested,
          { chatId, messageId },
          "Message delete timed out",
        ),
      };

      return Response.json(body);
    }

    if (request.method === "PUT") {
      return Response.json(createModelState(await updateModel(chatId, await request.json())));
    }

    const settings = await SettingsService.instance.getAll(chatId);
    await refreshAiModels(resolveAiProvider(settings), true);

    return Response.json(createModelState(settings));
  } catch (error) {
    let message = String(error);

    if (error instanceof Error) {
      message = error.message;
    }

    return errorResponse(sanitizeErrorMessage(message) ?? "", 400);
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
    port,
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

  await server.stop();
  server = undefined;
}
