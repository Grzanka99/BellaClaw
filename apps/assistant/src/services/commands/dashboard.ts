import { createDashboardLinkToken } from "@bellaclaw/shared";
import type { TCommand, TCommandResult } from "./types";

// a one-time link to the dashboard page at path, signed for the address the command came from
function createLinkReply(addressKey: string, path: string): TCommandResult {
  const publicUrl = Bun.env.BELLACLAW_DASHBOARD_PUBLIC_URL?.trim();
  const secret = Bun.env.BELLACLAW_DASHBOARD_SECRET?.trim();

  if (!publicUrl || !secret) {
    return "The dashboard is not configured.";
  }

  const token = createDashboardLinkToken(secret, addressKey, Date.now());

  return {
    confidential: `${publicUrl.replace(/\/$/, "")}${path}?token=${token}\nThis link works once and expires in 10 minutes.`,
  };
}

export const dashboardCommand: TCommand = {
  name: "dashboard",
  description: "Get a one-time link that connects this chat to your dashboard account",
  usage: "!dashboard",
  handler: async (_chatId, _args, _ctx, addressKey) => createLinkReply(addressKey, "/link"),
};

// NOTE: the page opens the app with the link and the server URL, or shows them as a code to copy
export const appCommand: TCommand = {
  name: "app",
  description: "Get a one-time link that signs the BellaClaw app in with this chat",
  usage: "!app",
  handler: async (_chatId, _args, _ctx, addressKey) => createLinkReply(addressKey, "/app"),
};
