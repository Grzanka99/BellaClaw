import { expect, test } from "bun:test";
import { createAssistantDatabase, createTestApp, registerApp } from "./test-utils";

test("only an upload may carry a body over 64 KiB", async () => {
  const database = await createAssistantDatabase();

  try {
    const { app, sendApp, assistant, store } = createTestApp(":memory:", database.reader);
    const alice = await registerApp(sendApp, store, "alice");
    const conversationKey = encodeURIComponent(`bella:${alice.publicId}`);
    const large = new Uint8Array(65_537);
    const post = (path: string) =>
      app.request(path, {
        method: "POST",
        // as the server receives it; a request built here has no such header
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "image/png",
          "Content-Length": String(large.byteLength),
        },
        body: large,
      });

    const message = await post(`/api/conversations/${conversationKey}/messages`);
    expect([message.status, await message.json()]).toEqual([
      413,
      { error: "Request body too large" },
    ]);
    expect((await post(`/api/conversations/${conversationKey}/media`)).status).toBe(200);
    expect(assistant.uploads).toHaveLength(1);

    // a chunked body declares no length
    const chunked = await app.request(`/api/conversations/${conversationKey}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
      body: new Blob([
        JSON.stringify({ clientMessageId: "m-1", text: "a".repeat(65_537) }),
      ]).stream(),
    });
    expect(chunked.status).toBe(400);
    expect(assistant.sends).toHaveLength(0);
  } finally {
    await database.remove();
  }
});
