import { z } from "zod";

export enum EAuthorizationStatus {
  Pending = "pending",
  Authorized = "authorized",
  Locked = "locked",
}

export const SAuthorizationState = z.object({
  chatId: z.string().min(1),
  status: z.enum(EAuthorizationStatus),
  failedAttempts: z.number().int().min(0).max(3),
});

export type TAuthorizationState = z.infer<typeof SAuthorizationState>;
