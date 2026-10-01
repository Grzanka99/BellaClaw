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
});
