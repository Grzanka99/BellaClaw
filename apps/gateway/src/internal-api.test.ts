import { expect, test } from "bun:test";
import { createInternalApi } from "./internal-api";

test("an upload streams to the assistant's media route with its type, and a download passes the assistant's bytes or its refusal on", async () => {
  const received: { path: string; type: string; auth: string; size: number }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      const data = new Uint8Array(await request.arrayBuffer());
      received.push({
        path: pathname,
        type: request.headers.get("content-type") ?? "",
        auth: request.headers.get("authorization") ?? "",
        size: data.byteLength,
      });

      if (pathname.endsWith("/media") && data.byteLength > 4) {
        return Response.json({ error: "The image is larger than 5 MB" }, { status: 413 });
      }

      if (pathname.endsWith("/media")) {
        return Response.json({ id: "image-1", mimeType: request.headers.get("content-type") });
      }

      if (pathname.endsWith("/image-1")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "image/gif" },
        });
      }

      return Response.json({ error: "Gone" }, { status: 410 });
    },
  });

  try {
    const api = createInternalApi(`http://127.0.0.1:${server.port}`, "secret");
    const body = (size: number) => new Response(new Uint8Array(size)).body;

    expect(await api.uploadMedia("acct-1", "bella:acct-1", "image/gif", body(3))).toEqual({
      data: { id: "image-1", mimeType: "image/gif" },
    });
    expect(await api.uploadMedia("acct-1", "bella:acct-1", "image/gif", body(9))).toEqual({
      error: "The image is larger than 5 MB",
      status: 413,
    });
    expect(received.slice(0, 1)).toEqual([
      {
        path: "/internal/accounts/acct-1/conversations/bella%3Aacct-1/media",
        type: "image/gif",
        auth: "Bearer secret",
        size: 3,
      },
    ]);

    const image = await api.downloadMedia("acct-1", "bella:acct-1", "image-1");
    if (!("data" in image)) {
      throw new Error("The download failed");
    }
    expect(image.data.headers.get("Content-Type")).toBe("image/gif");
    expect(new Uint8Array(await image.data.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(await api.downloadMedia("acct-1", "bella:acct-1", "image-2")).toEqual({
      error: "Gone",
      status: 410,
    });
  } finally {
    await server.stop(true);
  }
});
