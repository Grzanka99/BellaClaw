import { int, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { fetchWeb } from "../../../lib/web";
import { defineTool } from "./define-tool";
import instructions from "./web-fetch.xml" with { type: "text" };

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

export function validateWebFetchArgs(
  args: Static<typeof SWebFetchArgs>,
): Static<typeof SWebFetchArgs> {
  const url = new URL(args.url);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url must use the http or https protocol");
  }

  return args;
}

export const webFetch = defineTool({
  name: "web-fetch",
  label: "Web fetch",
  description:
    "Fetch a public http or https URL and return its content as markdown, plain text, or raw HTML. Use after web-search when page content is needed.",
  schema: SWebFetchArgs,
  instructions,
  mode: "parallel",
  execute: async (_context, args, signal) => {
    return fetchWeb(validateWebFetchArgs(args), signal);
  },
});
