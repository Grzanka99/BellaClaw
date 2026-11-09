import { logger, type TOption } from "@bellaclaw/shared";
import type { Models } from "@earendil-works/pi-ai";
import { ModelsError } from "@earendil-works/pi-ai/utils/models-error";
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

export type TAiAuthChannel = {
  listChatIds: () => Promise<readonly string[]>;
  send: (chatId: string, text: string) => Promise<void>;
};

let channel: TOption<TAiAuthChannel>;
const pendingLogins = new Map<EAiProvider, AbortController>();
const alertedProviders = new Set<EAiProvider>();

export function registerAiAuthChannel(nextChannel: TAiAuthChannel) {
  channel = nextChannel;
}

export function findAiOAuthProvider(providerId: string): TOption<EAiProvider> {
  return AI_OAUTH_PROVIDERS.find((provider) => provider === providerId);
}

function loginHint(providerId: EAiProvider): string {
  return `Run !ai-auth login ${providerId}`;
}

async function send(chatId: string, text: string) {
  if (channel === undefined) {
    logger.warning(`AI auth: no chat channel to send notice to ${chatId}`);
    return;
  }

  try {
    await channel.send(chatId, text);
  } catch (error) {
    logger.error(`AI auth: failed to send notice to ${chatId}: ${String(error)}`);
  }
}

function isRejectedRefresh(error: unknown): boolean {
  if (!(error instanceof ModelsError) || error.code !== "oauth") {
    return false;
  }

  let cause: unknown = error.cause;

  while (cause instanceof Error) {
    if (/\(4\d\d\)|invalid_grant|invalid_refresh_token/.test(cause.message)) {
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
export async function describeAiAuthProblem(provider: string): Promise<TOption<string>> {
  const providerId = findAiOAuthProvider(provider);

  if (providerId === undefined) {
    return undefined;
  }

  const state = await getAiAuthState(providerId);

  if (state === EAiAuthState.LoginExpired) {
    return `The ${providerId} login has expired. ${loginHint(providerId)}.`;
  }

  if (state === EAiAuthState.NotConnected) {
    return `${providerId} is not connected. ${loginHint(providerId)}.`;
  }

  return undefined;
}

// Refreshes every OAuth credential and sends one alert to all chats when logins break.
export async function checkAiOAuth(models: Models = aiModels): Promise<void> {
  const chatIds = (await channel?.listChatIds()) ?? [];
  const selectedProviders = new Set<string>();

  for (const chatId of chatIds) {
    const settings = await SettingsService.instance.getAll(chatId);
    selectedProviders.add(settings[EConfigKey.AiProvider]);
  }

  const problems: string[] = [];
  let hasNewProblem = false;

  for (const providerId of AI_OAUTH_PROVIDERS) {
    const state = await getAiAuthState(providerId, models);
    let problem: TOption<string>;

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
        hasNewProblem = true;
        alertedProviders.add(providerId);
      }
    }
  }

  if (!hasNewProblem) {
    return;
  }

  const text = `AI login needed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`;

  for (const chatId of chatIds) {
    await send(chatId, text);
  }
}

// Starts a device-code login and resolves with the instructions for the user.
export async function beginAiLogin(chatId: string, providerId: EAiProvider): Promise<string> {
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
        await send(chatId, `Connected ${providerId}.`);
      },
      async (error) => {
        instructions.reject(error);

        if (instructionsSent && !controller.signal.aborted) {
          await send(chatId, `Login for ${providerId} failed: ${String(error)}`);
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
  const credential = await aiCredentials.read(providerId);

  if (credential?.type !== "oauth") {
    return `${providerId}: not connected.`;
  }

  if (alertedProviders.has(providerId)) {
    return `${providerId}: login expired. ${loginHint(providerId)}.`;
  }

  return `${providerId}: connected with OAuth, access token expires ${new Date(credential.expires).toISOString()}.`;
}

export async function logoutAi(providerId: EAiProvider): Promise<void> {
  pendingLogins.get(providerId)?.abort(new Error("Logged out"));
  await aiModels.logout(providerId);
  alertedProviders.delete(providerId);
}
