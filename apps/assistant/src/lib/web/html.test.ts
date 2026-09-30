import { describe, expect, test } from "bun:test";
import { formatWebContent } from "./html";

describe("formatWebContent", () => {
  test("strips hidden markup before markdown conversion", async () => {
    const result = await formatWebContent({
      html: [
        "<body>",
        "<style>.hidden { color: red; }</style>",
        "<h1>Hello</h1>",
        "<script>hidden()</script>",
        "<p>World</p>",
        "</body>",
      ].join(""),
      format: "markdown",
    });

    expect(result.content).toContain("Hello");
    expect(result.content).toContain("World");
    expect(result.content).not.toContain("hidden()");
    expect(result.content).not.toContain(".hidden");
    expect(result.truncated).toBe(false);
  });

  for (const { name, closingHead } of [
    { name: "explicit", closingHead: "</head>" },
    { name: "omitted", closingHead: "" },
  ]) {
    test(`extracts body text with an ${name} head closing tag`, async () => {
      const result = await formatWebContent({
        html: `<html><head><title>Hidden title</title><script>hidden()</script><style>.hidden { color: red; }</style>${closingHead}<body><p>Visible</p><script>alsoHidden()</script><p>After</p></body></html>`,
        format: "text",
      });

      expect(result).toEqual({ content: "Visible After", truncated: false });
    });
  }
});
