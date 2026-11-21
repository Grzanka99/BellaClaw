import { z } from "zod";
import { EMessagePlatform } from "../messaging/types";

export enum EIdentityLinkState {
  Migrating = "migrating",
  Active = "active",
}

// the services that move an address's rows to its account when it is linked
export enum EIdentityLinkOwner {
  Memory = "memory",
  Conversation = "conversation",
  Settings = "settings",
  Calendar = "calendar",
  Cron = "cron",
  Automations = "automations",
  McpAuth = "mcp-auth",
  Lists = "lists",
}

export const SIdentityLink = z.object({
  channel: z.enum(EMessagePlatform),
  address: z.string().min(1),
  accountId: z.string().min(1),
  state: z.enum(EIdentityLinkState),
  linkedAt: z.date(),
});

export type TIdentityLink = z.infer<typeof SIdentityLink>;
