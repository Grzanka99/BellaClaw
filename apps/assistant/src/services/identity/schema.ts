import { z } from "zod";
import { EMessagePlatform } from "../messaging/types";

export enum EIdentityLinkState {
  Migrating = "migrating",
  Active = "active",
}

export const SIdentityLink = z.object({
  channel: z.enum(EMessagePlatform),
  address: z.string().min(1),
  accountId: z.string().min(1),
  state: z.enum(EIdentityLinkState),
  linkedAt: z.date(),
});

export type TIdentityLink = z.infer<typeof SIdentityLink>;
