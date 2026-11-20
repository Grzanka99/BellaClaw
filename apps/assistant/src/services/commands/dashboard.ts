import { createDashboardLinkToken } from "@bellaclaw/shared";
import { IdentityService, type TChatAddress } from "../identity";
import { EMessagePlatform } from "../messaging/types";
import type { TCommand, TCommandResult } from "./types";

// a one-time link to the dashboard page at path, signed for the address the command came from.
// NOTE: a link signs in with a chat; the app's own address is none, and the app is signed in
function createLinkReply(address: TChatAddress, path: string): TCommandResult {
  if (address.channel === EMessagePlatform.App) {
    return "This app is signed in to your account already; the dashboard or another device signs in with your username and password, or with a link asked from a linked Signal or Discord chat.";
  }

  const publicUrl = Bun.env.BELLACLAW_DASHBOARD_PUBLIC_URL?.trim();
  const secret = Bun.env.BELLACLAW_DASHBOARD_SECRET?.trim();

  if (!publicUrl || !secret) {
    return "The dashboard is not configured.";
  }

  const token = createDashboardLinkToken(
    secret,
    IdentityService.instance.addressKey(address),
    Date.now(),
  );

  return {
    confidential: `${publicUrl.replace(/\/$/, "")}${path}?token=${token}\nThis link works once and expires in 10 minutes.`,
  };
}

export const dashboardCommand: TCommand = {
  name: "dashboard",
  description: "Get a one-time link that connects this chat to your dashboard account",
  usage: "!dashboard",
  handler: async (_chatId, _args, _ctx, address) => createLinkReply(address, "/link"),
};

// NOTE: the page opens the app with the link and the server URL, or shows them as a code to copy
export const appCommand: TCommand = {
  name: "app",
  description: "Get a one-time link that signs the BellaClaw app in with this chat",
  usage: "!app",
  handler: async (_chatId, _args, _ctx, address) => createLinkReply(address, "/app"),
};
