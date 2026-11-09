import { logger } from "@bellaclaw/shared";
import { checkAiOAuth } from ".";

const OAUTH_KEEP_ALIVE_INTERVAL_MS = 60 * 60 * 1000;

async function keepAiOAuthAlive() {
  try {
    await checkAiOAuth();
  } catch (error) {
    logger.warning(`AI OAuth keep-alive failed: ${String(error)}`);
  }
}

// Pi refreshes OAuth only when the provider is used, so an unselected provider's
// refresh token could otherwise sit unused until it expires.
export function startAiOAuthKeepAlive() {
  void keepAiOAuthAlive();
  return setInterval(() => {
    void keepAiOAuthAlive();
  }, OAUTH_KEEP_ALIVE_INTERVAL_MS);
}
