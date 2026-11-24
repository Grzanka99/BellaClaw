import { EEventType } from "@bellaclaw/database";
import { COMMAND_CATALOG } from "@bellaclaw/shared";
import { AI_OAUTH_PROVIDERS, findAiOAuthProvider, getAiAuthStatus } from "../ai/auth";
import { AuthorizationService } from "../authorization";
import type { TCommand } from "./types";

const USAGE = `Usage: !ai-auth login|status|logout PROVIDER (${AI_OAUTH_PROVIDERS.join(", ")})`;

export const aiAuthCommand: TCommand = {
  entry: COMMAND_CATALOG["ai-auth"],
  handler: async (chatId, args, ctx, address) => {
    const [action, provider, extra] = args.trim().split(/\s+/);

    if (
      action === undefined ||
      provider === undefined ||
      extra !== undefined ||
      !["login", "status", "logout"].includes(action)
    ) {
      return { text: USAGE, state: "failed", outcome: "usage" };
    }

    const providerId = findAiOAuthProvider(provider);

    if (providerId === undefined) {
      return { text: USAGE, state: "failed", outcome: "usage" };
    }

    // The login is shared, so it must not be changeable while the activation gate is disabled.
    if (!(await AuthorizationService.instance.isActivated(address))) {
      return {
        text: "AI authentication requires BELLACLAW_ACTIVATION_TOKEN and an activated chat.",
        state: "failed",
        outcome: "not activated",
      };
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
        return {
          confidential: started.payload.instructions,
          state: "done",
          outcome: "login started",
        };
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
        return {
          text: `Logged out of ${providerId}.`,
          state: "done",
          outcome: `logged out of ${providerId}`,
        };
      }

      return { text: await getAiAuthStatus(providerId), state: "done", outcome: "status" };
    } catch (error) {
      return {
        text: `AI authentication failed: ${String(error)}`,
        state: "failed",
        outcome: "failed",
      };
    }
  },
};
