import { z } from "zod";

export const SEventAttachment = z.object({
  id: z.string(),
  contentType: z.string(),
  filename: z.string().nullable(),
  size: z.number(),
});

export const SEvent = z.object({
  id: z.number(),
  at: z.number(),
  chat: z.string(),
  kind: z.enum(["message", "typing", "receipt", "noise"]),
  direction: z.enum(["in", "out"]),
  text: z.string().nullable(),
  attachments: z.array(SEventAttachment),
  signalTimestamp: z.number().nullable(),
});

export type TEventAttachment = z.infer<typeof SEventAttachment>;
export type TEvent = z.infer<typeof SEvent>;
export type TEventKind = TEvent["kind"];
export type TEventDirection = TEvent["direction"];

export const SSendRequest = z.object({
  from: z.string(),
  text: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        contentType: z.string(),
        data: z.string(),
        voiceNote: z.boolean(),
      }),
    )
    .default([]),
});

export const SFromRequest = z.object({ from: z.string() });

export const SWaitRequest = z.object({ from: z.string(), after: z.number().optional() });

export const SGroupRequest = z.object({ from: z.string(), group: z.string(), text: z.string() });

export const SNoiseRequest = z.object({
  from: z.string(),
  type: z.enum(["receipt", "typing", "sync"]),
});

export const SDeliveryResponse = z.object({ timestamp: z.number(), delivered: z.boolean() });

export const SWaitResponse = z.object({ ready: z.boolean(), messages: z.array(SEvent) });

export const SLogResponse = z.object({ events: z.array(SEvent) });

export const SChatsResponse = z.object({
  chats: z.array(
    z.object({ number: z.string(), inbound: z.number(), outbound: z.number(), lastAt: z.number() }),
  ),
});

export const SStatusResponse = z.object({
  up: z.boolean(),
  assistantNumber: z.string(),
  assistantConnected: z.boolean(),
  pending: z.number(),
});

export const SDisconnectResponse = z.object({ closed: z.number() });

export const SErrorResponse = z.object({ error: z.string() });
