import { describe, expect, test } from "bun:test";
import { parseDuckDuckGoResults } from "../../runtime/tools/executors/web-search";

describe("parseDuckDuckGoResults", () => {
  test("parses DuckDuckGo HTML, decodes uddg, and deduplicates URLs", async () => {
    const targetUrl = "https://example.com/docs?x=1&y=2";
    const html = `
      <html>
        <body>
          <div class="result">
            <a class="result__a" href="/l/?uddg=${encodeURIComponent(targetUrl)}"> Example Docs </a>
            <a class="result__snippet"> Official docs snippet. </a>
          </div>
          <div class="result">
            <a class="result__a" href="${targetUrl}">Duplicate Docs</a>
            <a class="result__snippet"> Duplicate snippet. </a>
          </div>
          <div class="result">
            <a class="result__a" href="https://other.example/page">Other Result</a>
            <a class="result__snippet"> Other snippet. </a>
          </div>
        </body>
      </html>
    `;

    const results = await parseDuckDuckGoResults(html, 10);

    expect(results).toEqual([
      {
        title: "Example Docs",
        url: targetUrl,
        snippet: "Official docs snippet.",
      },
      {
        title: "Other Result",
        url: "https://other.example/page",
        snippet: "Other snippet.",
      },
    ]);
  });

  test("returns no results when organic results are absent", async () => {
    const results = await parseDuckDuckGoResults(
      "<html><body><p>No organic hits</p></body></html>",
      5,
    );

    expect(results).toEqual([]);
  });
});
