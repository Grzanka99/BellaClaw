import { decodeHTML } from "entities";
import TurndownService from "turndown";
import type { TWebContentFormat } from "./types";

const HIDDEN_ELEMENT_SELECTOR = "script, style, noscript, iframe, object, embed";
const HIDDEN_TEXT_SELECTOR = `head, title, ${HIDDEN_ELEMENT_SELECTOR}`;

export async function formatWebContent(args: {
  html: string;
  format: TWebContentFormat;
}): Promise<string> {
  switch (args.format) {
    case "html": {
      return args.html;
    }
    case "text": {
      return extractVisibleText(args.html);
    }
    case "markdown": {
      return new TurndownService().turndown(await stripHiddenMarkup(args.html));
    }
  }
}

export async function extractVisibleText(html: string): Promise<string> {
  const bodyChunks: string[] = [];
  const documentChunks: string[] = [];
  let bodyText = "";
  let documentText = "";
  let bodyElementFound = false;
  let skippedDepth = 0;

  await new HTMLRewriter()
    .on(HIDDEN_TEXT_SELECTOR, {
      element(element) {
        if (!element.canHaveContent) {
          return;
        }
        skippedDepth += 1;
        element.onEndTag(() => {
          skippedDepth -= 1;
        });
      },
    })
    .onDocument({
      text(text) {
        if (skippedDepth === 0) {
          documentText += text.text;
          if (text.lastInTextNode) {
            documentChunks.push(decodeHTML(documentText));
            documentText = "";
          }
        }
      },
    })
    .on("body", {
      element() {
        bodyElementFound = true;
        skippedDepth = 0;
      },
      text(text) {
        if (skippedDepth === 0) {
          bodyText += text.text;
          if (text.lastInTextNode) {
            bodyChunks.push(decodeHTML(bodyText));
            bodyText = "";
          }
        }
      },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html" } }))
    .text();

  if (bodyElementFound) {
    return bodyChunks.join(" ").replace(/\s+/g, " ").trim();
  }

  return documentChunks.join(" ").replace(/\s+/g, " ").trim();
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
