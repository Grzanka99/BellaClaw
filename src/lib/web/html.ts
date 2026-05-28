import TurndownService from "turndown";
import type { TWebContentFormat } from "./types";

export type TFormattedWebContent = {
  content: string;
  truncated: boolean;
};

const MAX_FORMATTED_CHARS = 80_000;
const HIDDEN_ELEMENT_SELECTOR = "script, style, noscript, iframe, object, embed";

export async function formatWebContent(args: {
  html: string;
  format: TWebContentFormat;
}): Promise<TFormattedWebContent> {
  let content: string;

  switch (args.format) {
    case "html": {
      content = args.html;
      break;
    }
    case "text": {
      content = await extractVisibleText(args.html);
      break;
    }
    case "markdown": {
      content = new TurndownService().turndown(await stripHiddenMarkup(args.html));
      break;
    }
  }

  if (content.length <= MAX_FORMATTED_CHARS) {
    return { content, truncated: false };
  }

  return {
    content: content.slice(0, MAX_FORMATTED_CHARS),
    truncated: true,
  };
}

export async function extractVisibleText(html: string): Promise<string> {
  const chunks: string[] = [];
  let skippedDepth = 0;

  await new HTMLRewriter()
    .on(HIDDEN_ELEMENT_SELECTOR, {
      element(element) {
        skippedDepth += 1;
        element.onEndTag(() => {
          skippedDepth -= 1;
        });
      },
    })
    .on("body", {
      text(text) {
        if (skippedDepth === 0) {
          chunks.push(text.text);
        }
      },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html" } }))
    .text();

  return chunks.join(" ").replace(/\s+/g, " ").trim();
}

async function stripHiddenMarkup(html: string): Promise<string> {
  return await new HTMLRewriter()
    .on(HIDDEN_ELEMENT_SELECTOR, {
      element(element) {
        element.remove();
      },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html" } }))
    .text();
}

export function isSupportedTextContentType(contentType: string): boolean {
  const [rawMediaType = ""] = contentType.split(";");
  const mediaType = rawMediaType.trim().toLowerCase();

  return (
    mediaType === "application/xhtml+xml" ||
    mediaType === "application/xml" ||
    mediaType === "application/json" ||
    mediaType.startsWith("text/")
  );
}
