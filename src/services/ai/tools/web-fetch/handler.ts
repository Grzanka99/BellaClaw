import z from "zod";
import type { TFetchWebResult } from "../../../../lib/web";

export const SWebFetchArgs = z.object({
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith("http://") || url.startsWith("https://"))
    .describe("Public http or https URL to fetch"),
  format: z
    .enum(["markdown", "text", "html"])
    .describe("Output format; defaults to markdown")
    .optional(),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(45)
    .describe("Timeout in seconds; defaults to 15 and cannot exceed 45")
    .optional(),
});

export type TWebFetchArgs = z.infer<typeof SWebFetchArgs>;

export type TWebFetch = TFetchWebResult;
