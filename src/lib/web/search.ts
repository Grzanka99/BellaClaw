import type { TOption } from "../../types";
import { fetchTextWithLimit, validatePublicHttpUrl } from "./http";
import type { TSearchWebArgs, TWebSearchResult } from "./types";

const SEARCH_TIMEOUT_MS = 25_000;
const SEARCH_MAX_BYTES = 1_000_000;

export async function searchWeb(args: TSearchWebArgs): Promise<TWebSearchResult[]> {
  const limit = args.limit ?? 5;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
  const { text } = await fetchTextWithLimit({
    url,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxBytes: SEARCH_MAX_BYTES,
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    followRedirects: true,
  });

  return parseDuckDuckGoResults(text, limit);
}

export async function parseDuckDuckGoResults(
  html: string,
  limit: number,
): Promise<TWebSearchResult[]> {
  const rawResults: TWebSearchResult[] = [];
  let currentContainer: TOption<TWebSearchResult>;
  let currentTitleResult: TOption<TWebSearchResult>;
  let currentSnippetResult: TOption<TWebSearchResult>;
  let lastStandaloneResult: TOption<TWebSearchResult>;

  await new HTMLRewriter()
    .on(".result", {
      element(element) {
        const result: TWebSearchResult = { title: "", url: "", snippet: "" };
        currentContainer = result;

        element.onEndTag(() => {
          if (currentContainer === result) {
            currentContainer = undefined;
          }

          if (result.url !== "") {
            rawResults.push(result);
          }
        });
      },
    })
    .on("a.result__a", {
      element(element) {
        const href = element.getAttribute("href");

        if (href === null) {
          currentTitleResult = undefined;
          return;
        }

        const decodedUrl = decodeDuckDuckGoUrl(href);

        if (decodedUrl === undefined) {
          currentTitleResult = undefined;
          return;
        }

        const result = currentContainer ?? { title: "", url: "", snippet: "" };
        result.url = decodedUrl;
        currentTitleResult = result;

        if (currentContainer === undefined) {
          rawResults.push(result);
          lastStandaloneResult = result;
        }

        element.onEndTag(() => {
          if (currentTitleResult === result) {
            currentTitleResult = undefined;
          }
        });
      },
      text(text) {
        if (currentTitleResult !== undefined) {
          currentTitleResult.title = `${currentTitleResult.title}${text.text}`;
        }
      },
    })
    .on(".result__snippet", {
      element(element) {
        const result = currentContainer ?? lastStandaloneResult;
        currentSnippetResult = result;

        element.onEndTag(() => {
          if (currentSnippetResult === result) {
            currentSnippetResult = undefined;
          }
        });
      },
      text(text) {
        if (currentSnippetResult !== undefined) {
          currentSnippetResult.snippet = `${currentSnippetResult.snippet}${text.text}`;
        }
      },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html" } }))
    .text();

  const seen = new Set<string>();
  const results: TWebSearchResult[] = [];

  for (const result of rawResults) {
    const title = normalizeText(decodeHtmlEntities(result.title));
    const snippet = normalizeText(decodeHtmlEntities(result.snippet));

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

function decodeDuckDuckGoUrl(href: string): TOption<string> {
  let url: URL;

  try {
    url = new URL(href, "https://duckduckgo.com");
  } catch {
    return undefined;
  }

  const uddg = url.searchParams.get("uddg");
  let candidate = url.href;

  if (url.pathname === "/l/" && uddg !== null) {
    candidate = uddg;
  }

  try {
    return validatePublicHttpUrl(candidate);
  } catch {
    return undefined;
  }
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const decoded = decodeHtmlEntity(entity);

    return decoded ?? match;
  });
}

function decodeHtmlEntity(entity: string): TOption<string> {
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    return decodeNumericHtmlEntity(entity.slice(2), 16);
  }

  if (entity.startsWith("#")) {
    return decodeNumericHtmlEntity(entity.slice(1), 10);
  }

  switch (entity.toLowerCase()) {
    case "amp": {
      return "&";
    }
    case "apos": {
      return "'";
    }
    case "gt": {
      return ">";
    }
    case "lt": {
      return "<";
    }
    case "nbsp": {
      return " ";
    }
    case "quot": {
      return '"';
    }
    default: {
      return undefined;
    }
  }
}

function decodeNumericHtmlEntity(value: string, radix: number): TOption<string> {
  const codePoint = Number.parseInt(value, radix);

  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return undefined;
  }

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return undefined;
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
