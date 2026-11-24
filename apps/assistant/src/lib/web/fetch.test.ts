import { describe, expect, test } from "bun:test";
import { fetchWeb } from "./fetch";

function page(body: string) {
  return {
    lookup: async () => [{ address: "93.184.216.34" }],
    request: async () => new Response(body, { headers: { "content-type": "text/html" } }),
  };
}

describe("fetchWeb", () => {
  test("returns a short page whole", async () => {
    const result = await fetchWeb(
      { url: "https://example.com/short", format: "text" },
      undefined,
      page("<body><p>Short page</p></body>"),
    );

    expect(result.content).toBe("Short page");
    expect(result.totalChars).toBe(10);
    expect(result.truncated).toBe(false);
    expect(result.nextStart).toBeUndefined();
  });

  test("returns a long page in parts the caller reads with start", async () => {
    // the limit counts decoded characters: 45,000 here, not the 270,000 of the source
    const network = page(`<body><p>${"&copy;".repeat(20_000)}${"b".repeat(25_000)}</p></body>`);
    const first = await fetchWeb(
      { url: "https://example.com/long", format: "text" },
      undefined,
      network,
    );

    expect(first.content).toBe("©".repeat(20_000));
    expect(first.totalChars).toBe(45_000);
    expect(first.truncated).toBe(true);
    expect(first.nextStart).toBe(20_000);

    const second = await fetchWeb(
      { url: "https://example.com/long", format: "text", start: first.nextStart },
      undefined,
      network,
    );

    expect(second.content).toBe("b".repeat(20_000));
    expect(second.nextStart).toBe(40_000);

    const last = await fetchWeb(
      { url: "https://example.com/long", format: "text", start: second.nextStart },
      undefined,
      network,
    );

    expect(last.content).toBe("b".repeat(5_000));
    expect(last.truncated).toBe(false);
    expect(last.nextStart).toBeUndefined();
  });
});
