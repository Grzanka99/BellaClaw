import { int, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import type { TFetchWebResult } from "../../../../lib/web";

export const SWebFetchArgs = obj({
  url: str({ format: "uri", description: "Public http or https URL to fetch" }),
  format: opt(oneOf(["markdown", "text", "html"])),
  timeout: opt(
    int({
      minimum: 1,
      maximum: 45,
      description: "Timeout in seconds; defaults to 15 and cannot exceed 45",
    }),
  ),
});

export type TWebFetchArgs = Static<typeof SWebFetchArgs>;

export type TWebFetch = TFetchWebResult;

export function validateWebFetchArgs(args: TWebFetchArgs): TWebFetchArgs {
  const url = new URL(args.url);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url must use the http or https protocol");
  }

  return args;
}
