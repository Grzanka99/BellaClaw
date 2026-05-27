import z from "zod";

export const SWebFetchArgs = z.object({
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith("http://") || url.startsWith("https://")),
  format: z.enum(["markdown", "text", "html"]).optional(),
  timeout: z.number().int().min(1).max(45).optional(),
});

export type TWebFetchArgs = z.infer<typeof SWebFetchArgs>;

export type TWebFetch = {
  url: string;
  contentType: string;
  format: "markdown" | "text" | "html";
  content: string;
  truncated: boolean;
};
