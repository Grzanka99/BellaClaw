import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import {
  SWebFetchArgs,
  type TWebFetch,
  type TWebFetchArgs,
} from "../../../tools/web-fetch/handler";
import { formatWebContent, isSupportedTextContentType } from "../../../tools/web-shared/html";
import { fetchTextWithLimit } from "../../../tools/web-shared/http";
import { normalizeError } from "../../serialization";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { createFailedToolResult, createSuccessfulToolResult } from "../results";

const FETCH_MAX_BYTES = 5_000_000;
const MAX_FORMATTED_CHARS = 80_000;

export async function executeWebFetchTool(
  toolCall: ChatMessageToolCall,
): Promise<TNormalizedToolResult> {
  const parsed = parseAndValidateToolArgs<TWebFetchArgs>(toolCall, SWebFetchArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  try {
    const result = await fetchWeb(parsed.data);

    return createSuccessfulToolResult(toolCall, result);
  } catch (error) {
    return createFailedToolResult(toolCall, normalizeError(error));
  }
}

export async function fetchWeb(args: TWebFetchArgs): Promise<TWebFetch> {
  const format = args.format ?? "markdown";
  const timeoutSeconds = args.timeout ?? 15;
  const { response, text, url } = await fetchTextWithLimit({
    url: args.url,
    timeoutMs: timeoutSeconds * 1000,
    maxBytes: FETCH_MAX_BYTES,
    followRedirects: true,
    headers: {
      accept: acceptHeaderForFormat(format),
    },
    validateResponseHeaders(response) {
      assertSupportedContentType(response.headers.get("content-type") ?? "");
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = isHtmlContentType(contentType);
  const formatted =
    !isHtml && format === "text"
      ? truncatePlainText(text)
      : await formatWebContent({
          html: isHtml || format === "html" ? text : escapePlainTextForFormatting(text),
          format,
        });

  return {
    url,
    contentType,
    format,
    content: formatted.content,
    truncated: formatted.truncated,
  };
}

function acceptHeaderForFormat(format: "markdown" | "text" | "html"): string {
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

function isHtmlContentType(contentType: string): boolean {
  const [mediaType = ""] = contentType.split(";");
  const normalized = mediaType.trim().toLowerCase();

  return normalized === "text/html" || normalized === "application/xhtml+xml";
}

function assertSupportedContentType(contentType: string): void {
  if (!isSupportedTextContentType(contentType)) {
    throw new Error(`Unsupported content type: ${contentType === "" ? "unknown" : contentType}`);
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
