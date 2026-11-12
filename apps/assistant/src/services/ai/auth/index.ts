import { createSystemTurnId } from "@bellaclaw/behavior-logs";
import { logger, type TOption } from "@bellaclaw/shared";
import type { Models } from "@earendil-works/pi-ai";
import { ModelsError } from "@earendil-works/pi-ai/utils/models-error";
import { AuthorizationService } from "../../authorization";
import { EventBus } from "../../events";
import { EEventType, type TEventPayloads } from "../../events/catalog";
import { SettingsService } from "../../settings";
import { EConfigKey } from "../../settings/schema";
import { aiCredentials, aiModels } from "../providers/registry";
import { EAiProvider } from "../types";

const AUTH_CHECK_TIMEOUT_MS = 30_000;

export const AI_OAUTH_PROVIDERS: readonly EAiProvider[] = [
  EAiProvider.OpenaiCodex,
  EAiProvider.OpencodeGo,
];

export enum EAiAuthState {
  Connected = "connected",
  NotConnected = "not_connected",
  LoginExpired = "login_expired",
  Unavailable = "unavailable",
}

const pendingLogins = new Map<EAiProvider, AbortController>();
const alertedProviders = new Set<EAiProvider>();

export function findAiOAuthProvider(providerId: string): TOption<EAiProvider> {
  return AI_OAUTH_PROVIDERS.find((provider) => provider === providerId);
}

function loginHint(providerId: EAiProvider): string {
  return `Run !ai-auth login ${providerId}`;
}

async function publishLoginOutcome<
  T extends EEventType.AiAuthLoginCompleted | EEventType.AiAuthLoginFailed,
>(chatId: string, type: T, payload: TEventPayloads[T]): Promise<void> {
  try {
    await EventBus.instance.publish({
      type,
      source: "ai-auth",
      key: chatId,
      trace: { turnId: createSystemTurnId(), chatId, platform: undefined },
      payload,
      causationId: undefined,
      dedupeKey: undefined,
    });
  } catch (error) {
    logger.error(`AI auth: failed to publish ${type} for ${chatId}: ${String(error)}`);
  }
}

function isRejectedRefresh(error: unknown): boolean {
  if (!(error instanceof ModelsError) || error.code !== "oauth") {
    return false;
  }

  let cause: unknown = error.cause;

  while (cause instanceof Error) {
    if (/\(4(?!29)\d\d\)|invalid_grant|invalid_refresh_token/.test(cause.message)) {
      return true;
    }
    cause = cause.cause;
  }

  return false;
}

export async function getAiAuthState(
  providerId: EAiProvider,
  models: Models = aiModels,
): Promise<EAiAuthState> {
  try {
    const auth = await models.getAuth(providerId, {
      signal: AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS),
    });

    if (auth === undefined) {
      return EAiAuthState.NotConnected;
    }

    return EAiAuthState.Connected;
  } catch (error) {
    if (isRejectedRefresh(error)) {
      return EAiAuthState.LoginExpired;
    }

    logger.warning(`AI auth: ${providerId} check failed: ${String(error)}`);
    return EAiAuthState.Unavailable;
  }
}

// Returns the reply for a failed chat turn when the provider needs a new login.
// Switches the chat to another connected OAuth provider when one exists.
export async function describeAiAuthProblem(
  chatId: string,
  provider: string,
  models: Models = aiModels,
): Promise<TOption<string>> {
  const providerId = findAiOAuthProvider(provider);

  if (providerId === undefined) {
    return undefined;
  }

  const state = await getAiAuthState(providerId, models);
  let problem: string;

  if (state === EAiAuthState.LoginExpired) {
    problem = `The ${providerId} login has expired.`;
  } else if (state === EAiAuthState.NotConnected) {
    problem = `${providerId} is not connected.`;
  } else {
    return undefined;
  }

  for (const other of AI_OAUTH_PROVIDERS) {
    if (other !== providerId && (await getAiAuthState(other, models)) === EAiAuthState.Connected) {
      await SettingsService.instance.set(chatId, EConfigKey.AiProvider, other);
      return `${problem} Switched this chat to ${other}. Send your message again.`;
    }
  }

  return `${problem} ${loginHint(providerId)}.`;
}

// Refreshes every OAuth credential and sends one alert to all chats when logins break.
// Stays silent while any provider is connected: a chat on a broken one is switched to it.
export async function checkAiOAuth(models: Models = aiModels): Promise<void> {
  const chatIds = await AuthorizationService.instance.listAuthorizedChatIds();
  const selectedProviders = new Set<string>();

  for (const chatId of chatIds) {
    const settings = await SettingsService.instance.getAll(chatId);
    selectedProviders.add(settings[EConfigKey.AiProvider]);
  }

  const problems: string[] = [];
  const newProblemProviders: EAiProvider[] = [];
  let anyConnected = false;

  for (const providerId of AI_OAUTH_PROVIDERS) {
    const state = await getAiAuthState(providerId, models);
    let problem: TOption<string>;

    if (state === EAiAuthState.Connected) {
      anyConnected = true;
    }

    if (state === EAiAuthState.LoginExpired) {
      problem = `${providerId}: login expired. ${loginHint(providerId)}`;
    } else if (state === EAiAuthState.NotConnected && selectedProviders.has(providerId)) {
      problem = `${providerId}: not connected. ${loginHint(providerId)}`;
    } else if (state !== EAiAuthState.Unavailable) {
      alertedProviders.delete(providerId);
    }

    if (problem !== undefined) {
      problems.push(problem);

      if (!alertedProviders.has(providerId)) {
        newProblemProviders.push(providerId);
      }
    }
  }

  if (anyConnected || newProblemProviders.length === 0) {
    return;
  }

  // Retry next check when no chat could receive the alert.
  if (chatIds.length === 0) {
    return;
  }

  await EventBus.instance.publish({
    type: EEventType.AiAuthLoginNeeded,
    source: "ai-auth",
    key: "global",
    trace: { turnId: createSystemTurnId(), chatId: undefined, platform: undefined },
    payload: { problems },
    causationId: undefined,
    dedupeKey: undefined,
  });

  for (const providerId of newProblemProviders) {
    alertedProviders.add(providerId);
  }
}

// Starts a device-code login and resolves with the instructions for the user.
// When no other OAuth provider is connected, the new login becomes the chat's AI provider.
export async function beginAiLogin(chatId: string, providerId: EAiProvider): Promise<string> {
  const otherStates = Promise.all(
    AI_OAUTH_PROVIDERS.filter((provider) => provider !== providerId).map((provider) =>
      getAiAuthState(provider),
    ),
  );
  pendingLogins.get(providerId)?.abort(new Error("Replaced by a newer login"));
  const controller = new AbortController();
  pendingLogins.set(providerId, controller);
  const instructions = Promise.withResolvers<string>();
  let instructionsSent = false;

  aiModels
    .login(providerId, "oauth", {
      signal: controller.signal,
      prompt: async (prompt) => {
        if (prompt.type === "select" && prompt.options.some(({ id }) => id === "device_code")) {
          return "device_code";
        }

        throw new Error(`Unsupported login prompt: ${prompt.message}`);
      },
      notify: (event) => {
        if (event.type === "device_code") {
          instructionsSent = true;
          instructions.resolve(
            `Open ${event.verificationUri} and enter code ${event.userCode} to connect ${providerId}.`,
          );
        }
      },
    })
    .then(
      async () => {
        alertedProviders.delete(providerId);
        let selected = false;

        if (!(await otherStates).includes(EAiAuthState.Connected)) {
          try {
            await SettingsService.instance.set(chatId, EConfigKey.AiProvider, providerId);
            selected = true;
          } catch (error) {
            logger.error(`AI auth: failed to select ${providerId} for ${chatId}: ${String(error)}`);
          }
        }

        await publishLoginOutcome(chatId, EEventType.AiAuthLoginCompleted, {
          chatId,
          providerId,
          selected,
        });
      },
      async (error) => {
        instructions.reject(error);

        if (instructionsSent && !controller.signal.aborted) {
          await publishLoginOutcome(chatId, EEventType.AiAuthLoginFailed, {
            chatId,
            providerId,
            error: String(error),
          });
        }
      },
    )
    .finally(() => {
      if (pendingLogins.get(providerId) === controller) {
        pendingLogins.delete(providerId);
      }
    });

  return instructions.promise;
}

export async function getAiAuthStatus(providerId: EAiProvider): Promise<string> {
  const state = await getAiAuthState(providerId);

  if (state === EAiAuthState.LoginExpired) {
    return `${providerId}: login expired. ${loginHint(providerId)}.`;
  }

  if (state === EAiAuthState.Unavailable) {
    return `${providerId}: login could not be checked right now. Try again later.`;
  }

  const credential = await aiCredentials.read(providerId);

  if (state === EAiAuthState.NotConnected || credential?.type !== "oauth") {
    return `${providerId}: not connected.`;
  }

  return `${providerId}: connected with OAuth, access token expires ${new Date(credential.expires).toISOString()}.`;
}

export async function logoutAi(providerId: EAiProvider): Promise<void> {
  pendingLogins.get(providerId)?.abort(new Error("Logged out"));
  await aiModels.logout(providerId);
  alertedProviders.delete(providerId);
}
