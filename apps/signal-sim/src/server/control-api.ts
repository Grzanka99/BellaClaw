import type { TOption } from "@bellaclaw/shared";
import type { z } from "zod";
import { newAttachmentId, writeAttachment } from "./attachments";
import {
  SFromRequest,
  SGroupRequest,
  SNoiseRequest,
  SSendRequest,
  SWaitRequest,
  type TEventAttachment,
} from "./control-schema";
import {
  directMessageEnvelope,
  groupMessageEnvelope,
  receiptEnvelope,
  syncSentEnvelope,
  type TEnvelopeAttachment,
  typingEnvelope,
} from "./envelopes";
import type { SimHub } from "./hub";
import { notFound } from "./signal-api";

// NOTE: the assistant may hide typing between messages of one turn; this quiet period keeps such
// turns together and also covers replies that arrive with no typing at all (reminders).
const SETTLE_MS = 1500;

async function body<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<{ data: z.infer<T> } | { response: Response }> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return { response: Response.json({ error: "invalid JSON body" }, { status: 400 }) };
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { response: Response.json({ error: parsed.error.message }, { status: 400 }) };
  }

  return { data: parsed.data };
}

async function send(hub: SimHub, request: Request): Promise<Response> {
  const parsed = await body(request, SSendRequest);
  if ("response" in parsed) {
    return parsed.response;
  }

  const { from, text, attachments } = parsed.data;
  if ((text === undefined || text.length === 0) && attachments.length === 0) {
    return Response.json({ error: "send needs text or an attachment" }, { status: 400 });
  }

  const timestamp = hub.nextTimestamp();
  const envelopeAttachments: TEnvelopeAttachment[] = [];
  const eventAttachments: TEventAttachment[] = [];
  for (const attachment of attachments) {
    const bytes = Buffer.from(attachment.data, "base64");
    const id = newAttachmentId(attachment.filename);
    await writeAttachment(hub.attachmentsDir, id, bytes);
    envelopeAttachments.push({
      contentType: attachment.contentType,
      filename: attachment.filename,
      id,
      size: bytes.length,
      isVoiceNote: attachment.voiceNote,
      uploadTimestamp: timestamp - 200,
    });
    eventAttachments.push({
      id,
      contentType: attachment.contentType,
      filename: attachment.filename,
      size: bytes.length,
    });
  }

  let messageText: TOption<string> = text;
  if (messageText !== undefined && messageText.length === 0) {
    messageText = undefined;
  }

  const { payload, delivered } = hub.deliver(
    directMessageEnvelope(from, timestamp, messageText, envelopeAttachments),
  );
  hub.store.addEvent({
    chat: from,
    kind: "message",
    direction: "in",
    text: messageText,
    attachments: eventAttachments,
    signalTs: timestamp,
    payload,
  });
  return Response.json({ timestamp, delivered });
}

async function group(hub: SimHub, request: Request): Promise<Response> {
  const parsed = await body(request, SGroupRequest);
  if ("response" in parsed) {
    return parsed.response;
  }

  const { from, group: groupId, text } = parsed.data;
  const timestamp = hub.nextTimestamp();
  const { delivered } = hub.deliver(groupMessageEnvelope(from, timestamp, groupId, text));
  hub.store.addEvent({
    chat: from,
    kind: "noise",
    direction: "in",
    text: `group ${groupId}: ${text}`,
    attachments: [],
    signalTs: timestamp,
    payload: undefined,
  });
  return Response.json({ timestamp, delivered });
}

async function duplicate(hub: SimHub, request: Request): Promise<Response> {
  const parsed = await body(request, SFromRequest);
  if ("response" in parsed) {
    return parsed.response;
  }

  const { from } = parsed.data;
  const last = hub.store.lastInbound(from);
  if (last === undefined) {
    return Response.json(
      { error: `no inbound message from ${from} to duplicate` },
      { status: 404 },
    );
  }

  const delivered = hub.deliverRaw(last.payload);
  const timestamp = last.signal_ts;
  hub.store.addEvent({
    chat: from,
    kind: "noise",
    direction: "in",
    text: `duplicate of ${timestamp}`,
    attachments: [],
    signalTs: timestamp,
    payload: undefined,
  });
  return Response.json({ timestamp, delivered });
}

async function noise(hub: SimHub, request: Request): Promise<Response> {
  const parsed = await body(request, SNoiseRequest);
  if ("response" in parsed) {
    return parsed.response;
  }

  const { from, type } = parsed.data;
  const timestamp = hub.nextTimestamp();
  let envelope: Record<string, unknown>;
  if (type === "receipt") {
    const acknowledged: number[] = [];
    const last = hub.store.lastOutboundTimestamp(from);
    if (last !== undefined) {
      acknowledged.push(last);
    }

    envelope = receiptEnvelope(from, timestamp, acknowledged);
  } else if (type === "typing") {
    envelope = typingEnvelope(from, timestamp);
  } else {
    envelope = syncSentEnvelope(hub.account, from, timestamp, "sent from a linked device");
  }

  const { delivered } = hub.deliver(envelope);
  hub.store.addEvent({
    chat: from,
    kind: "noise",
    direction: "in",
    text: `${type} envelope`,
    attachments: [],
    signalTs: timestamp,
    payload: undefined,
  });
  return Response.json({ timestamp, delivered });
}

async function wait(hub: SimHub, request: Request): Promise<Response> {
  const parsed = await body(request, SWaitRequest);
  if ("response" in parsed) {
    return parsed.response;
  }

  const messages = hub.store.takeReplies(parsed.data.from, SETTLE_MS, parsed.data.after);
  if (messages === undefined) {
    return Response.json({ ready: false, messages: [] });
  }

  return Response.json({ ready: true, messages });
}

function log(hub: SimHub, url: URL): Response {
  const from = url.searchParams.get("from");
  if (from === null) {
    return Response.json({ error: "from is required" }, { status: 400 });
  }

  let limit = Number(url.searchParams.get("limit") ?? "50");
  if (!Number.isInteger(limit) || limit <= 0) {
    limit = 50;
  }

  const events = hub.store.events(from, limit, url.searchParams.get("events") === "true");
  return Response.json({ events });
}

export async function handleControlApi(hub: SimHub, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;

  if (route === "GET /sim/status") {
    return Response.json({
      up: true,
      assistantNumber: hub.account,
      assistantConnected: hub.connected(),
      pending: hub.store.pendingCount(),
    });
  }

  if (route === "GET /sim/chats") {
    return Response.json({ chats: hub.store.chats() });
  }

  if (route === "GET /sim/log") {
    return log(hub, url);
  }

  if (route === "POST /sim/send") {
    return send(hub, request);
  }

  if (route === "POST /sim/wait") {
    return wait(hub, request);
  }

  if (route === "POST /sim/group") {
    return group(hub, request);
  }

  if (route === "POST /sim/duplicate") {
    return duplicate(hub, request);
  }

  if (route === "POST /sim/noise") {
    return noise(hub, request);
  }

  if (route === "POST /sim/disconnect") {
    return Response.json({ closed: hub.disconnect() });
  }

  return notFound();
}
