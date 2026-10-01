import { describe, expect, test } from "bun:test";
import { formatWebContent } from "./html";

describe("formatWebContent", () => {
  test("extracts visible text around embedded content while excluding scripts and styles", async () => {
    const result = await formatWebContent({
      html: '<body><p>Before</p><embed src="a.pdf"><script>hidden()</script><style>.hidden { color: red; }</style><p>Visible</p><p>After</p></body>',
      format: "text",
    });

    expect(result).toEqual({ content: "Before Visible After", truncated: false });
  });

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

describe("HTML entity text formatting", () => {
  test("decodes named and numeric entities exactly once", async () => {
    const result = await formatWebContent({
      html: "<body><p>Fish &amp; chips &lt;3 &#169; &#x1F600; &copy; &amp;lt;</p></body>",
      format: "text",
    });

    expect(result).toEqual({
      content: "Fish & chips <3 © 😀 © &lt;",
      truncated: false,
    });
  });

  test("preserves literal characters and normalizes whitespace", async () => {
    const result = await formatWebContent({
      html: "Plain  text\n with < 3 and > 2 & signs",
      format: "text",
    });

    expect(result.content).toBe("Plain text with < 3 and > 2 & signs");
  });

  test("keeps entity references and words intact across rewriter chunks", async () => {
    const text = `${"x".repeat(1023)}&amp;lt;${"y".repeat(2050)}`;
    const result = await formatWebContent({
      html: `<body><p>${text}</p><p> next </p></body>`,
      format: "text",
    });

    expect(result.content).toBe(`${"x".repeat(1023)}&lt;${"y".repeat(2050)} next`);
    expect(result.truncated).toBe(false);
  });

  test("applies the character limit after decoding", async () => {
    const result = await formatWebContent({
      html: `<body><p>${"&copy;".repeat(80_001)}</p></body>`,
      format: "text",
    });

    expect(result.content).toBe("©".repeat(80_000));
    expect(result.truncated).toBe(true);
  });
});
