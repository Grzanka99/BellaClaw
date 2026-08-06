import { formatWebContent, isSupportedTextContentType, type TFormattedWebContent } from "./html";
import { fetchTextWithLimit } from "./http";
import type { TFetchWebArgs, TFetchWebResult, TWebContentFormat } from "./types";

const FETCH_MAX_BYTES = 5_000_000;
const MAX_FORMATTED_CHARS = 80_000;

export async function fetchWeb(
  args: TFetchWebArgs,
  signal?: AbortSignal,
): Promise<TFetchWebResult> {
  const format = args.format ?? "markdown";
  const timeoutSeconds = args.timeout ?? 15;
  const { response, text, url } = await fetchTextWithLimit({
    url: args.url,
    timeoutMs: timeoutSeconds * 1000,
    maxBytes: FETCH_MAX_BYTES,
    followRedirects: true,
    signal,
    headers: {
      accept: acceptHeaderForFormat(format),
    },
    validateResponseHeaders(response) {
      const contentType = response.headers.get("content-type") ?? "";

      if (!isSupportedTextContentType(contentType)) {
        let displayContentType = contentType;

        if (displayContentType === "") {
          displayContentType = "unknown";
        }

        throw new Error(`Unsupported content type: ${displayContentType}`);
      }
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const [mediaType = ""] = contentType.split(";");
  const normalizedContentType = mediaType.trim().toLowerCase();
  const isHtml =
    normalizedContentType === "text/html" || normalizedContentType === "application/xhtml+xml";
  let formatted: TFormattedWebContent;

  if (!isHtml && format === "text") {
    formatted = truncatePlainText(text);
  } else {
    let html = text;

    if (!isHtml && format !== "html") {
      html = escapePlainTextForFormatting(text);
    }

    formatted = await formatWebContent({
      html,
      format,
    });
  }

  return {
    url,
    contentType,
    format,
    content: formatted.content,
    truncated: formatted.truncated,
  };
}

function acceptHeaderForFormat(format: TWebContentFormat): string {
  switch (format) {
    case "html": {
      return "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";
    }
    case "text": {
      return "text/plain,text/html;q=0.9,application/xhtml+xml;q=0.8,*/*;q=0.5";
    }
    case "markdown": {
      return "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5";
    }
  }
}

function truncatePlainText(text: string): { content: string; truncated: boolean } {
  if (text.length <= MAX_FORMATTED_CHARS) {
    return { content: text, truncated: false };
  }

  return {
    content: text.slice(0, MAX_FORMATTED_CHARS),
    truncated: true,
  };
}

function escapePlainTextForFormatting(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  return `<body>${escaped}</body>`;
}
