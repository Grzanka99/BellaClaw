// NOTE: fake of bbernhard/signal-cli-rest-api in json-rpc mode. Status codes and error bodies
// follow src/api/api.go: errors are `{"error": "..."}`, gin's unknown route is a plain-text 404.

import { rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { TOption } from "@bellaclaw/shared";
import { z } from "zod";
import {
  attachmentPath,
  listAttachments,
  newAttachmentId,
  parseBase64Attachment,
  writeAttachment,
} from "./attachments";
import type { TEventAttachment } from "./control-schema";
import type { SimHub } from "./hub";

const INVALID_REQUEST = "Couldn't process request - invalid request";

const SSendMessageV2 = z.object({
  number: z.string().default(""),
  recipients: z.array(z.string()).nullable().default([]),
  recipient: z.string().default(""),
  message: z.string().default(""),
  base64_attachments: z.array(z.string()).nullable().default([]),
  text_mode: z.enum(["normal", "styled"]).optional(),
});

const SReceipt = z.object({
  recipient: z.string().default(""),
  receipt_type: z.string().default(""),
  timestamp: z.number().int().default(0),
});

const STypingIndicator = z.object({ recipient: z.string().default("") });

export function notFound(): Response {
  return new Response("404 page not found", {
    status: 404,
    headers: { "content-type": "text/plain" },
  });
}

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

async function readJson(request: Request): Promise<TOption<unknown>> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function accountFromPath(hub: SimHub, raw: string): TOption<Response> {
  if (decodeURIComponent(raw) !== hub.account) {
    return error(400, `User ${decodeURIComponent(raw)} is not registered.`);
  }

  return undefined;
}

function about(): Response {
  return Response.json({
    versions: ["v1", "v2"],
    build: 2,
    mode: "json-rpc",
    version: "signal-sim",
    capabilities: { "v2/send": ["quotes", "mentions"] },
  });
}

async function sendV2(hub: SimHub, request: Request): Promise<Response> {
  const parsed = SSendMessageV2.safeParse(await readJson(request));
  if (!parsed.success) {
    return error(400, INVALID_REQUEST);
  }

  const body = parsed.data;
  const recipients = [...(body.recipients ?? [])];
  if (body.recipient !== "") {
    recipients.push(body.recipient);
  }

  if (recipients.length === 0) {
    return error(400, "Couldn't process request - please provide at least one recipient");
  }

  if (body.number !== hub.account) {
    return error(400, `User ${body.number} is not registered.`);
  }

  const timestamp = hub.nextTimestamp();
  const attachments: TEventAttachment[] = [];
  for (const raw of body.base64_attachments ?? []) {
    const attachment = parseBase64Attachment(raw);
    if (attachment === undefined) {
      return error(400, "illegal base64 data");
    }

    const id = newAttachmentId(attachment.filename);
    let contentType = attachment.contentType;
    if (contentType === undefined) {
      contentType = Bun.file(id).type.split(";")[0] ?? "application/octet-stream";
    }

    await writeAttachment(resolve(hub.attachmentsDir, "sent"), id, attachment.bytes);
    attachments.push({
      id,
      contentType,
      filename: attachment.filename ?? null,
      size: attachment.bytes.length,
    });
  }

  for (const recipient of recipients) {
    hub.store.addEvent({
      chat: recipient,
      kind: "message",
      direction: "out",
      text: body.message,
      attachments,
      signalTs: timestamp,
      payload: undefined,
    });
  }

  return Response.json([{ timestamp: String(timestamp) }], { status: 201 });
}

async function receipt(hub: SimHub, request: Request, number: string): Promise<Response> {
  const parsed = SReceipt.safeParse(await readJson(request));
  if (!parsed.success) {
    return error(400, INVALID_REQUEST);
  }

  const accountError = accountFromPath(hub, number);
  if (accountError !== undefined) {
    return accountError;
  }

  const body = parsed.data;
  if (body.recipient === "") {
    return error(400, "Couldn't process request - recipient missing");
  }

  if (body.receipt_type !== "read" && body.receipt_type !== "viewed") {
    return error(400, "Couldn't process request - receipt type must be read or viewed");
  }

  if (body.timestamp === 0) {
    return error(400, "Couldn't process request - timestamp missing");
  }

  hub.store.addEvent({
    chat: body.recipient,
    kind: "receipt",
    direction: "out",
    text: body.receipt_type,
    attachments: [],
    signalTs: body.timestamp,
    payload: undefined,
  });
  return new Response(null, { status: 204 });
}

async function typing(
  hub: SimHub,
  request: Request,
  number: string,
  state: "on" | "off",
): Promise<Response> {
  const parsed = STypingIndicator.safeParse(await readJson(request));
  if (!parsed.success) {
    return error(400, INVALID_REQUEST);
  }

  const accountError = accountFromPath(hub, number);
  if (accountError !== undefined) {
    return accountError;
  }

  hub.store.addEvent({
    chat: parsed.data.recipient,
    kind: "typing",
    direction: "out",
    text: state,
    attachments: [],
    signalTs: undefined,
    payload: undefined,
  });
  return new Response(null, { status: 204 });
}

async function attachment(hub: SimHub, method: string, id: string): Promise<Response> {
  const path = attachmentPath(hub.attachmentsDir, decodeURIComponent(id));
  if (path === undefined) {
    return error(400, "Please provide a valid attachment name");
  }

  const isFile = await stat(path).then(
    (stats) => stats.isFile(),
    () => false,
  );
  if (!isFile) {
    return error(404, "No attachment with that name found");
  }

  if (method === "DELETE") {
    await rm(path);
    return new Response(null, { status: 204 });
  }

  const file = Bun.file(path);
  let contentType = file.type.split(";")[0];
  if (contentType === undefined || contentType.length === 0) {
    contentType = "application/octet-stream";
  }

  return new Response(file, { headers: { "content-type": contentType } });
}

export async function handleSignalApi(hub: SimHub, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  const route = `${request.method} /${parts.slice(0, 2).join("/")}`;
  const param = parts[2];

  if (parts.length === 2) {
    if (route === "GET /v1/about") {
      return about();
    }

    if (route === "POST /v2/send") {
      return sendV2(hub, request);
    }

    if (route === "GET /v1/attachments") {
      return Response.json(listAttachments(hub.attachmentsDir));
    }
  }

  if (parts.length === 3 && param !== undefined) {
    if (route === "POST /v1/receipts") {
      return receipt(hub, request, param);
    }

    if (route === "PUT /v1/typing-indicator") {
      return typing(hub, request, param, "on");
    }

    if (route === "DELETE /v1/typing-indicator") {
      return typing(hub, request, param, "off");
    }

    if (route === "GET /v1/attachments" || route === "DELETE /v1/attachments") {
      return attachment(hub, request.method, param);
    }
  }

  return notFound();
}
