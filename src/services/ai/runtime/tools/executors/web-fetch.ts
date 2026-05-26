import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { SWebFetchArgs, type TWebFetchArgs } from "../../../tools/web-fetch/handler";
import { formatWebContent, isSupportedTextContentType } from "../../../tools/web-shared/html";
import { fetchTextWithLimit } from "../../../tools/web-shared/http";
import { normalizeError } from "../../serialization";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { createFailedToolResult, createSuccessfulToolResult } from "../results";

const FETCH_MAX_BYTES = 5_000_000;

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

export async function fetchWeb(args: TWebFetchArgs) {
  const format = args.format ?? "markdown";
  const timeoutSeconds = args.timeout ?? 30;
  const { response, text, url } = await fetchTextWithLimit({
    url: args.url,
    timeoutMs: timeoutSeconds * 1000,
    maxBytes: FETCH_MAX_BYTES,
    followRedirects: true,
    headers: {
      accept: acceptHeaderForFormat(format),
    },
  });
  const contentType = response.headers.get("content-type") ?? "";

  if (!isSupportedTextContentType(contentType)) {
    throw new Error("Unsupported or binary content type");
  }

  const isHtml = isHtmlContentType(contentType);
  const formatted = await formatWebContent({
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
  const normalized = contentType.toLowerCase();

  return normalized.includes("text/html") || normalized.includes("application/xhtml+xml");
}

function escapePlainTextForFormatting(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  return `<body>${escaped}</body>`;
}
