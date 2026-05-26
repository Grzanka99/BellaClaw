import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { SWebSearchArgs, type TWebSearchArgs } from "../../../tools/web-search/handler";
import { fetchTextWithLimit } from "../../../tools/web-shared/http";
import { normalizeError } from "../../serialization";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { createFailedToolResult, createSuccessfulToolResult } from "../results";

const SEARCH_TIMEOUT_MS = 25_000;
const SEARCH_MAX_BYTES = 1_000_000;

type TParsedResult = {
  title: string;
  url: string;
  snippet: string;
};

export async function executeWebSearchTool(
  toolCall: ChatMessageToolCall,
): Promise<TNormalizedToolResult> {
  const parsed = parseAndValidateToolArgs<TWebSearchArgs>(toolCall, SWebSearchArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  try {
    const results = await searchWeb(parsed.data);

    return createSuccessfulToolResult(toolCall, {
      query: parsed.data.query,
      results,
    });
  } catch (error) {
    return createFailedToolResult(toolCall, normalizeError(error));
  }
}

async function searchWeb(args: TWebSearchArgs): Promise<TParsedResult[]> {
  const limit = args.limit ?? 5;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
  const { text } = await fetchTextWithLimit({
    url,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxBytes: SEARCH_MAX_BYTES,
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  return parseDuckDuckGoResults(text, limit);
}

export async function parseDuckDuckGoResults(
  html: string,
  limit: number,
): Promise<TParsedResult[]> {
  const rawResults: TParsedResult[] = [];
  let currentResult: TParsedResult | undefined;

  await new HTMLRewriter()
    .on("a.result__a", {
      element(element) {
        const href = element.getAttribute("href");

        if (href === null) {
          currentResult = undefined;
          return;
        }

        currentResult = {
          title: "",
          url: decodeDuckDuckGoUrl(href),
          snippet: "",
        };
        rawResults.push(currentResult);
      },
      text(text) {
        if (currentResult !== undefined) {
          currentResult.title = `${currentResult.title}${text.text}`;
        }
      },
    })
    .on(".result__snippet", {
      text(text) {
        const lastResult = rawResults.at(-1);

        if (lastResult !== undefined) {
          lastResult.snippet = `${lastResult.snippet}${text.text}`;
        }
      },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html" } }))
    .text();

  const seen = new Set<string>();
  const results: TParsedResult[] = [];

  for (const result of rawResults) {
    const title = normalizeText(result.title);
    const snippet = normalizeText(result.snippet);

    if (title === "" || result.url === "" || seen.has(result.url)) {
      continue;
    }

    seen.add(result.url);
    results.push({ title, url: result.url, snippet });

    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function decodeDuckDuckGoUrl(href: string): string {
  const url = new URL(href, "https://duckduckgo.com");
  const uddg = url.searchParams.get("uddg");

  if (url.pathname === "/l/" && uddg !== null) {
    return uddg;
  }

  return url.href;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
