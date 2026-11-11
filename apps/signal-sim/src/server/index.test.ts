import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startSimServer, type TSimServer } from ".";

const ACCOUNT = "+10000000000";
const USER = "+15550000001";

let home: string;
let sim: TSimServer;
let base: string;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "signal-sim-test-"));
  sim = startSimServer({
    hostname: "127.0.0.1",
    port: 0,
    transcriptDb: resolve(home, "sim.db"),
    attachmentsDir: resolve(home, "attachments"),
    account: ACCOUNT,
  });
  base = `http://127.0.0.1:${sim.server.port}`;
});

afterEach(async () => {
  await sim.stop();
  rmSync(home, { recursive: true, force: true });
});

function post(path: string, body: unknown, method = "POST") {
  return fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function connect(): Promise<{ socket: WebSocket; frames: unknown[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${sim.server.port}/v1/receive/${ACCOUNT}`);
  const frames: unknown[] = [];
  socket.onmessage = (event) => {
    frames.push(JSON.parse(String(event.data)));
  };
  return new Promise((resolveOpen) => {
    socket.onopen = () => resolveOpen({ socket, frames });
  });
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) {
    await Bun.sleep(50);
  }
}

test("a queued user message reaches the receive socket in signal-cli's envelope shape", async () => {
  const sent = (await (await post("/sim/send", { from: USER, text: "hello" })).json()) as {
    timestamp: number;
    delivered: boolean;
  };
  expect(sent.delivered).toBe(false);

  const { socket, frames } = await connect();
  await until(() => frames.length > 0);
  socket.close();

  expect(frames).toEqual([
    {
      account: ACCOUNT,
      envelope: expect.objectContaining({
        source: USER,
        sourceNumber: USER,
        sourceDevice: 1,
        timestamp: sent.timestamp,
        dataMessage: expect.objectContaining({
          timestamp: sent.timestamp,
          message: "hello",
          expiresInSeconds: 0,
          viewOnce: false,
        }),
      }),
    },
  ]);
});

test("wait returns assistant replies only after typing is off, and only once", async () => {
  await post("/sim/send", { from: USER, text: "hi" });
  expect((await post(`/v1/typing-indicator/${ACCOUNT}`, { recipient: USER }, "PUT")).status).toBe(
    204,
  );
  const send = await post("/v2/send", {
    message: "Hello there",
    number: ACCOUNT,
    recipients: [USER],
    text_mode: "styled",
  });
  expect(send.status).toBe(201);
  expect(await send.json()).toEqual([{ timestamp: expect.any(String) }]);

  expect(await (await post("/sim/wait", { from: USER })).json()).toEqual({
    ready: false,
    messages: [],
  });

  await post(`/v1/typing-indicator/${ACCOUNT}`, { recipient: USER }, "DELETE");
  let result = { ready: false, messages: [{ text: "" }] };
  for (let i = 0; i < 60 && !result.ready; i++) {
    result = (await (await post("/sim/wait", { from: USER })).json()) as typeof result;
    await Bun.sleep(100);
  }

  expect(result.ready).toBe(true);
  expect(result.messages.map((message) => message.text)).toEqual(["Hello there"]);
  expect(await (await post("/sim/wait", { from: USER })).json()).toMatchObject({ ready: false });
});

test("a reply left unread from an earlier turn does not answer a new send", async () => {
  await post("/v2/send", { message: "Old reply", number: ACCOUNT, recipients: [USER] });
  await Bun.sleep(1_600);
  const sent = (await (await post("/sim/send", { from: USER, text: "next" })).json()) as {
    timestamp: number;
  };

  expect(
    await (await post("/sim/wait", { from: USER, after: sent.timestamp })).json(),
  ).toMatchObject({ ready: false });
  expect(await (await post("/sim/wait", { from: USER })).json()).toMatchObject({ ready: true });
});

test("attachments round trip in both directions", async () => {
  const { socket, frames } = await connect();
  const bytes = Buffer.from("fake png bytes");
  await post("/sim/send", {
    from: USER,
    attachments: [
      {
        filename: "photo.png",
        contentType: "image/png",
        data: bytes.toString("base64"),
        voiceNote: false,
      },
    ],
  });
  await until(() => frames.length > 0);
  socket.close();

  const frame = frames[0];
  if (typeof frame !== "object" || frame === null || !("envelope" in frame)) {
    throw new Error("missing envelope");
  }

  const envelope = frame.envelope as {
    dataMessage: { message: null; attachments: { id: string; size: number }[] };
  };
  expect(envelope.dataMessage.message).toBeNull();
  const attachment = envelope.dataMessage.attachments[0];
  expect(attachment).toMatchObject({
    contentType: "image/png",
    filename: "photo.png",
    size: bytes.length,
    isVoiceNote: false,
  });
  expect(attachment?.id).toMatch(/^[A-Za-z0-9_-]{20}\.png$/);

  const download = await fetch(`${base}/v1/attachments/${attachment?.id}`);
  expect(download.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  expect(await (await fetch(`${base}/v1/attachments`)).json()).toEqual([attachment?.id]);

  const reply = await post("/v2/send", {
    message: "",
    number: ACCOUNT,
    recipients: [USER],
    base64_attachments: [`data:audio/aac;filename=note.aac;base64,${bytes.toString("base64")}`],
  });
  expect(reply.status).toBe(201);
  const log = (await (await fetch(`${base}/sim/log?from=${encodeURIComponent(USER)}`)).json()) as {
    events: { attachments: unknown[] }[];
  };
  expect(log.events.at(-1)?.attachments).toEqual([
    {
      id: expect.stringMatching(/\.aac$/),
      contentType: "audio/aac",
      filename: "note.aac",
      size: 14,
    },
  ]);
});

test("unknown paths return gin's plain 404", async () => {
  const response = await fetch(`${base}/v1/nope`);
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("404 page not found");
});
