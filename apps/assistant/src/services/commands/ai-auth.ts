import { AI_OAUTH_PROVIDERS, findAiOAuthProvider, getAiAuthStatus } from "../ai/auth";
import { AuthorizationService } from "../authorization";
import { EEventType } from "../events/catalog";
import type { TCommand } from "./types";

const USAGE = `Usage: !ai-auth login|status|logout PROVIDER (${AI_OAUTH_PROVIDERS.join(", ")})`;

export const aiAuthCommand: TCommand = {
  name: "ai-auth",
  description: "Log in to, check, or log out of an AI provider subscription.",
  usage: "!ai-auth login|status|logout PROVIDER",
  handler: async (chatId, args, ctx) => {
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
        const started = await ctx.request(
          EEventType.AiAuthLoginRequested,
          { chatId, providerId },
          {
            outcome: EEventType.AiAuthLoginStarted,
            step: undefined,
            key: "global",
            timeoutMs: undefined,
          },
        );
        return started.payload.instructions;
      }

      if (action === "logout") {
        await ctx.request(
          EEventType.AiAuthLogoutRequested,
          { providerId },
          {
            outcome: EEventType.AiAuthLoggedOut,
            step: undefined,
            key: "global",
            timeoutMs: undefined,
          },
        );
        return `Logged out of ${providerId}.`;
      }

      return await getAiAuthStatus(providerId);
    } catch (error) {
      return `AI authentication failed: ${String(error)}`;
    }
  },
};
