import {
  AI_OAUTH_PROVIDERS,
  beginAiLogin,
  findAiOAuthProvider,
  getAiAuthStatus,
  logoutAi,
} from "../../ai/auth";
import { AuthorizationService } from "../../authorization";
import type { TCommand } from "./types";

const USAGE = `Usage: !ai-auth login|status|logout PROVIDER (${AI_OAUTH_PROVIDERS.join(", ")})`;

export const aiAuthCommand: TCommand = {
  name: "ai-auth",
  description: "Log in to, check, or log out of an AI provider subscription.",
  usage: "!ai-auth login|status|logout PROVIDER",
  handler: async (chatId, args) => {
    const [action, provider, extra] = args.trim().split(/\s+/);

    if (
      action === undefined ||
      provider === undefined ||
      extra !== undefined ||
      !["login", "status", "logout"].includes(action)
    ) {
      return USAGE;
    }

    const providerId = findAiOAuthProvider(provider);

    if (providerId === undefined) {
      return USAGE;
    }

    // The login is shared, so it must not be changeable while the activation gate is disabled.
    if (!(await AuthorizationService.instance.listAuthorizedChatIds()).includes(chatId)) {
      return "AI authentication requires BELLACLAW_ACTIVATION_TOKEN and an activated chat.";
    }

    try {
      if (action === "login") {
        return await beginAiLogin(chatId, providerId);
      }

      if (action === "logout") {
        await logoutAi(providerId);
        return `Logged out of ${providerId}.`;
      }

      return await getAiAuthStatus(providerId);
    } catch (error) {
      return `AI authentication failed: ${String(error)}`;
    }
  },
};
