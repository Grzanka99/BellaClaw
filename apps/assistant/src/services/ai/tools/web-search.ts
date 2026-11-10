import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { searchWeb } from "../../../lib/web";
import { defineTool } from "./define-tool";
import instructions from "./web-search.xml" with { type: "text" };

export const SWebSearchArgs = obj({
  query: str({ minLength: 1, description: "Search query to submit to Tavily" }),
  maxResults: opt(
    int({
      minimum: 1,
      maximum: 10,
      description: "Maximum number of results; defaults to 5",
    }),
  ),
  topic: opt(oneOf(["general", "news", "finance"])),
  timeRange: opt(oneOf(["day", "week", "month", "year"])),
});

export const webSearch = defineTool({
  name: "web-search",
  label: "Web search",
  description:
    "Search the public web with Tavily for current information. Use for recent facts, news, documentation, or sources not available in conversation context.",
  schema: SWebSearchArgs,
  instructions,
  mode: "parallel",
  execute: async (_context, args, signal) => {
    return { query: args.query, results: await searchWeb(args, signal) };
  },
});
