import z from "zod";
import type { TSearchWebArgs, TWebSearchResult } from "./types";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const SEARCH_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_RESULTS = 5;
const RESPONSE_MESSAGE_MAX_LENGTH = 300;

const STavilySearchResult = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
  score: z.number(),
});

const STavilySearchResponse = z.object({
  results: z.array(STavilySearchResult),
});

type TTavilySearchRequest = {
  query: string;
  search_depth: "basic";
  max_results: number;
  include_answer: false;
  include_raw_content: false;
  include_images: false;
  topic?: "general" | "news" | "finance";
  time_range?: "day" | "week" | "month" | "year";
};

export async function searchWeb(args: TSearchWebArgs): Promise<TWebSearchResult[]> {
  const apiKey = Bun.env.TAVILY_API_KEY?.trim();

  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("TAVILY_API_KEY is required for web search");
  }

  let maxResults = DEFAULT_MAX_RESULTS;

  if (args.maxResults !== undefined) {
    maxResults = args.maxResults;
  }

  const body: TTavilySearchRequest = {
    query: args.query,
    search_depth: "basic",
    max_results: maxResults,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
  };

  if (args.topic !== undefined) {
    body.topic = args.topic;
  }

  if (args.timeRange !== undefined) {
    body.time_range = args.timeRange;
  }

  const response = await fetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const message = await readShortResponseMessage(response);

    if (response.status === 432) {
      throw new Error(
        `Tavily quota exhausted: plan or API key limit reached (HTTP 432): ${message}`,
      );
    }

    if (response.status === 433) {
      throw new Error(`Tavily quota exhausted: pay-as-you-go limit reached (HTTP 433): ${message}`);
    }

    throw new Error(`Tavily search failed with status ${response.status}: ${message}`);
  }

  let responseJson: unknown;

  try {
    responseJson = await response.json();
  } catch (error) {
    throw new Error(`Tavily search returned invalid JSON: ${normalizeUnknownError(error)}`);
  }

  const parsed = STavilySearchResponse.safeParse(responseJson);

  if (!parsed.success) {
    throw new Error(`Tavily search returned malformed response: ${parsed.error.message}`);
  }

  return parsed.data.results;
}

async function readShortResponseMessage(response: Response): Promise<string> {
  let text = "";

  try {
    text = await response.text();
  } catch (error) {
    text = normalizeUnknownError(error);
  }

  const normalized = text.replace(/\s+/g, " ").trim();

  if (normalized.length > RESPONSE_MESSAGE_MAX_LENGTH) {
    return `${normalized.slice(0, RESPONSE_MESSAGE_MAX_LENGTH)}...`;
  }

  if (normalized.length > 0) {
    return normalized;
  }

  const statusText = response.statusText.trim();

  if (statusText.length > 0) {
    return statusText;
  }

  return "no response body";
}

function normalizeUnknownError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
