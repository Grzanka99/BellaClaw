import { type Static, Type } from "@earendil-works/pi-ai";
import type { TFetchWebResult } from "../../../../lib/web";

export const SWebFetchArgs = Type.Object(
  {
    url: Type.String({ format: "uri", description: "Public http or https URL to fetch" }),
    format: Type.Optional(
      Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html")]),
    ),
    timeout: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 45,
        description: "Timeout in seconds; defaults to 15 and cannot exceed 45",
      }),
    ),
  },
  { additionalProperties: false },
);

export type TWebFetchArgs = Static<typeof SWebFetchArgs>;

export type TWebFetch = TFetchWebResult;

export function validateWebFetchArgs(args: TWebFetchArgs): TWebFetchArgs {
  const url = new URL(args.url);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url must use the http or https protocol");
  }

  return args;
}
