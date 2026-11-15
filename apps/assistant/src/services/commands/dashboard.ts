import { createDashboardLinkToken } from "@bellaclaw/shared";
import type { TCommand } from "./types";

export const dashboardCommand: TCommand = {
  name: "dashboard",
  description: "Get a one-time link that connects this chat to your dashboard account",
  usage: "!dashboard",
  handler: async (chatId) => {
    const publicUrl = Bun.env.BELLACLAW_DASHBOARD_PUBLIC_URL?.trim();
    const secret = Bun.env.BELLACLAW_DASHBOARD_SECRET?.trim();

    if (!publicUrl || !secret) {
      return "The dashboard is not configured.";
    }

    const token = createDashboardLinkToken(secret, chatId, Date.now());

    return `${publicUrl.replace(/\/$/, "")}/link?token=${token}\nThis link works once and expires in 10 minutes.`;
  },
};
