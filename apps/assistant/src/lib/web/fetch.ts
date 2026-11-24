import type { TOption } from "@bellaclaw/shared";
import { formatWebContent, isSupportedTextContentType } from "./html";
import { fetchTextWithLimit } from "./http";
import type { TFetchWebArgs, TFetchWebResult, TWebContentFormat } from "./types";

const FETCH_MAX_BYTES = 5_000_000;
// One call returns this much of the formatted page; `start` reads a later part. It stays well
// under the harness cap on a tool result, so the JSON around it is never cut.
const PART_MAX_CHARS = 20_000;

export async function fetchWeb(
  args: TFetchWebArgs,
  signal?: AbortSignal,
  network?: Parameters<typeof fetchTextWithLimit>[1],
): Promise<TFetchWebResult> {
  const format = args.format ?? "markdown";
  const timeoutSeconds = args.timeout ?? 15;
  const { response, text, url } = await fetchTextWithLimit(
    {
      url: args.url,
      timeoutMs: timeoutSeconds * 1000,
      maxBytes: FETCH_MAX_BYTES,
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
    },
    network,
  );
  const contentType = response.headers.get("content-type") ?? "";
  const [mediaType = ""] = contentType.split(";");
  const normalizedContentType = mediaType.trim().toLowerCase();
  const isHtml =
    normalizedContentType === "text/html" || normalizedContentType === "application/xhtml+xml";
  let formatted = text;

  if (isHtml || format !== "text") {
    let html = text;

    if (!isHtml && format !== "html") {
      html = escapePlainTextForFormatting(text);
    }

    formatted = await formatWebContent({
      html,
      format,
    });
  }

  const start = args.start ?? 0;
  const end = start + PART_MAX_CHARS;
  let nextStart: TOption<number>;

  if (end < formatted.length) {
    nextStart = end;
  }

  // content goes last, so the fields the model acts on come first
  return {
    url,
    contentType,
    format,
    totalChars: formatted.length,
    truncated: nextStart !== undefined,
    nextStart,
    content: formatted.slice(start, end),
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

function escapePlainTextForFormatting(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  return `<body>${escaped}</body>`;
}
