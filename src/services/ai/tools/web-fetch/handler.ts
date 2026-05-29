import z from "zod";
import type { TFetchWebArgs, TFetchWebResult } from "../../../../lib/web";

export const SWebFetchArgs = z.object({
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith("http://") || url.startsWith("https://")),
  format: z.enum(["markdown", "text", "html"]).optional(),
  timeout: z.number().int().min(1).max(45).optional(),
});

export type TWebFetchArgs = TFetchWebArgs;

export type TWebFetch = TFetchWebResult;
