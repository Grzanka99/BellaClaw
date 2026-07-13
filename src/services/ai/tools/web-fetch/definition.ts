import { createToolDefinition } from "../definition";
import { SWebFetchArgs } from "./handler";

export const WEB_FETCH_TOOL = "web-fetch";

export const webFetchTool = createToolDefinition(
  WEB_FETCH_TOOL,
  "Fetch a public http or https URL and return its content as markdown, plain text, or raw HTML. Use after web-search when page content is needed.",
  SWebFetchArgs,
);
