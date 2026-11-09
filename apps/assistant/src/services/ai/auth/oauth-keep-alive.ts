import { logger } from "@bellaclaw/shared";
import type { Models } from "@earendil-works/pi-ai";
import { aiModels } from "../providers/registry";
import { EAiProvider } from "../types";

const OAUTH_KEEP_ALIVE_INTERVAL_MS = 60 * 60 * 1000;

// Pi refreshes OAuth only when the provider is used, so an unselected provider's
// refresh token could otherwise sit unused until it expires.
export async function keepOpenaiCodexOAuthAlive(models: Models = aiModels): Promise<void> {
  try {
    await models.getAuth(EAiProvider.OpenaiCodex, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    logger.warning(`OpenAI Codex OAuth keep-alive failed: ${String(error)}`);
  }
}

export function startOpenaiCodexOAuthKeepAlive() {
  void keepOpenaiCodexOAuthAlive();
  return setInterval(() => {
    void keepOpenaiCodexOAuthAlive();
  }, OAUTH_KEEP_ALIVE_INTERVAL_MS);
}
