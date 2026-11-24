import { COMMAND_CATALOG, createGatewayLinkToken } from "@bellaclaw/shared";
import { IdentityService, type TChatAddress } from "../identity";
import { EMessagePlatform } from "../messaging/types";
import type { TCommand, TCommandResult } from "./types";

// a one-time link to the dashboard page at path, signed for the address the command came from.
// NOTE: a link signs in with a chat; the app's own address is none, and the app is signed in
function createLinkReply(address: TChatAddress, path: string): TCommandResult {
  if (address.channel === EMessagePlatform.App) {
    return {
      text: "This app is signed in to your account already; the dashboard or another device signs in with your username and password, or with a link asked from a linked Signal or Discord chat.",
      state: "done",
      outcome: "already signed in",
    };
  }

  const publicUrl = Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL?.trim();
  const secret = Bun.env.BELLACLAW_GATEWAY_SECRET?.trim();

  if (!publicUrl || !secret) {
    return { text: "The dashboard is not configured.", state: "failed", outcome: "not configured" };
  }

  const token = createGatewayLinkToken(
    secret,
    IdentityService.instance.addressKey(address),
    Date.now(),
  );

  return {
    confidential: `${publicUrl.replace(/\/$/, "")}${path}?token=${token}\nThis link works once and expires in 10 minutes.`,
    state: "done",
    outcome: "link sent",
  };
}

export const dashboardCommand: TCommand = {
  entry: COMMAND_CATALOG.dashboard,
  handler: async (_chatId, _args, _ctx, address) => createLinkReply(address, "/link"),
};

// NOTE: the page opens the app with the link and the server URL, or shows them as a code to copy
export const appCommand: TCommand = {
  entry: COMMAND_CATALOG.app,
  handler: async (_chatId, _args, _ctx, address) => createLinkReply(address, "/app"),
};
