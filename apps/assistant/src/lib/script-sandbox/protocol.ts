import { z } from "zod";

export const SFetchedText = z.object({
  url: z.string(),
  status: z.number(),
  contentType: z.string(),
  text: z.string(),
});

export const SRunMessage = z.object({
  type: z.literal("run"),
  source: z.string(),
  ctxJson: z.string(),
  memoryBytes: z.number(),
  cpuMs: z.number(),
  maxLogLines: z.number(),
});

export const SFetchReplyMessage = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("fetch-reply"),
    id: z.number(),
    ok: z.literal(true),
    result: SFetchedText,
  }),
  z.object({
    type: z.literal("fetch-reply"),
    id: z.number(),
    ok: z.literal(false),
    error: z.string(),
  }),
]);

export const SMainToWorkerMessage = z.union([SRunMessage, SFetchReplyMessage]);

export const SWorkerToMainMessage = z.union([
  z.object({ type: z.literal("fetch"), id: z.number(), url: z.string() }),
  z.object({ type: z.literal("log"), line: z.string() }),
  z.object({ type: z.literal("done"), ok: z.literal(true), json: z.string().optional() }),
  z.object({ type: z.literal("done"), ok: z.literal(false), error: z.string() }),
]);

export type TRunMessage = z.infer<typeof SRunMessage>;
export type TFetchReplyMessage = z.infer<typeof SFetchReplyMessage>;
export type TWorkerToMainMessage = z.infer<typeof SWorkerToMainMessage>;
