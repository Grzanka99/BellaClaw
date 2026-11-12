import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { TOption } from "@bellaclaw/shared";
import { formatEvent } from "./cli/format";
import { SimUnreachableError, simRequest } from "./cli/request";
import { DEFAULT_USER_NUMBER } from "./config";
import {
  SChatsResponse,
  SDeliveryResponse,
  SDisconnectResponse,
  SLogResponse,
  SStatusResponse,
  SWaitResponse,
  type TEvent,
} from "./server/control-schema";
import { runStackCommand } from "./stack";

const USAGE = `usage: bun run sim <command> [--json]

  send [--from N] [--image PATH]... [--audio PATH]... [--wait] [--timeout S] [TEXT]
  wait [--from N] [--timeout S]           block until the assistant finishes its turn (exit 1 on timeout)
  log [--from N] [--limit K] [--events]   transcript; --events adds typing, receipts and noise
  chats                                   numbers seen, with message counts
  status                                  sim and assistant receive socket state
  group [--from N] --group ID TEXT        deliver a group message envelope
  duplicate [--from N]                    redeliver N's last inbound envelope unchanged
  disconnect                              drop the assistant's receive WebSocket
  noise [--from N] --type receipt|typing|sync
  down | reset | vault-token              stack commands`;

const WAIT_POLL_MS = 250;
const DEFAULT_WAIT_SECONDS = 120;

const OPTIONS = {
  json: { type: "boolean" },
  from: { type: "string", default: DEFAULT_USER_NUMBER },
  timeout: { type: "string" },
  wait: { type: "boolean" },
  image: { type: "string", multiple: true },
  audio: { type: "string", multiple: true },
  limit: { type: "string" },
  events: { type: "boolean" },
  group: { type: "string" },
  type: { type: "string" },
} as const;

type TArgs = ReturnType<typeof parse>["values"];

function parse(args: string[]) {
  return parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
}

function print(json: boolean, value: unknown, lines: string[]) {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }

  for (const line of lines) {
    console.log(line);
  }
}

function seconds(raw: TOption<string>, fallback: number): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}

async function fileAttachment(path: string, voiceNote: boolean) {
  const file = Bun.file(resolve(path));
  if (!(await file.exists())) {
    throw new Error(`file not found: ${path}`);
  }

  let contentType = file.type.split(";")[0];
  if (contentType === undefined || contentType.length === 0) {
    contentType = "application/octet-stream";
  }

  return {
    filename: basename(path),
    contentType,
    data: Buffer.from(await file.arrayBuffer()).toString("base64"),
    voiceNote,
  };
}

async function wait(values: TArgs, after: TOption<number>): Promise<number> {
  const deadline = Date.now() + seconds(values.timeout, DEFAULT_WAIT_SECONDS) * 1000;
  let messages: TEvent[] = [];
  while (Date.now() < deadline) {
    const result = await simRequest("/sim/wait", SWaitResponse, {
      from: values.from,
      after,
    });
    if (result.ready) {
      messages = result.messages;
      break;
    }

    await Bun.sleep(WAIT_POLL_MS);
  }

  if (messages.length === 0) {
    print(values.json === true, { timeout: true, messages: [] }, ["timeout: no reply"]);
    return 1;
  }

  print(values.json === true, { timeout: false, messages }, messages.map(formatEvent));
  return 0;
}

async function send(values: TArgs, positionals: string[]): Promise<number> {
  const attachments = [];
  for (const path of values.image ?? []) {
    attachments.push(await fileAttachment(path, false));
  }

  for (const path of values.audio ?? []) {
    attachments.push(await fileAttachment(path, true));
  }

  let text: TOption<string>;
  if (positionals.length > 0) {
    text = positionals.join(" ");
  }

  const result = await simRequest("/sim/send", SDeliveryResponse, {
    from: values.from,
    text,
    attachments,
  });
  if (values.wait === true) {
    return wait(values, result.timestamp);
  }

  let state = "queued";
  if (result.delivered) {
    state = "delivered";
  }

  print(values.json === true, result, [`sent ${result.timestamp} (${state})`]);
  return 0;
}

async function delivery(path: string, values: TArgs, body: unknown): Promise<number> {
  const result = await simRequest(path, SDeliveryResponse, body);
  let state = "queued";
  if (result.delivered) {
    state = "delivered";
  }

  print(values.json === true, result, [`${result.timestamp} (${state})`]);
  return 0;
}

async function run(command: string, values: TArgs, positionals: string[]): Promise<number> {
  const json = values.json === true;

  if (command === "send") {
    return send(values, positionals);
  }

  if (command === "wait") {
    return wait(values, undefined);
  }

  if (command === "log") {
    const params = new URLSearchParams({ from: values.from, limit: values.limit ?? "50" });
    if (values.events === true) {
      params.set("events", "true");
    }

    const result = await simRequest(`/sim/log?${params}`, SLogResponse);
    print(json, result, result.events.map(formatEvent));
    return 0;
  }

  if (command === "chats") {
    const result = await simRequest("/sim/chats", SChatsResponse);
    const lines = result.chats.map(
      (chat) => `${chat.number} in=${chat.inbound} out=${chat.outbound}`,
    );
    print(json, result, lines);
    return 0;
  }

  if (command === "status") {
    const result = await simRequest("/sim/status", SStatusResponse);
    let socket = "assistant not connected";
    if (result.assistantConnected) {
      socket = "assistant connected";
    }

    print(json, result, [`sim up, ${socket}, ${result.pending} queued`]);
    return 0;
  }

  if (command === "group") {
    if (values.group === undefined || positionals.length === 0) {
      throw new Error("group needs --group ID and TEXT");
    }

    return delivery("/sim/group", values, {
      from: values.from,
      group: values.group,
      text: positionals.join(" "),
    });
  }

  if (command === "duplicate") {
    return delivery("/sim/duplicate", values, { from: values.from });
  }

  if (command === "noise") {
    return delivery("/sim/noise", values, { from: values.from, type: values.type });
  }

  if (command === "disconnect") {
    const result = await simRequest("/sim/disconnect", SDisconnectResponse, {});
    print(json, result, [`closed ${result.closed} receive socket(s)`]);
    return 0;
  }

  return 2;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    console.error(USAGE);
    return 2;
  }

  const ownCommands = [
    "send",
    "wait",
    "log",
    "chats",
    "status",
    "group",
    "duplicate",
    "disconnect",
    "noise",
  ];
  if (!ownCommands.includes(command)) {
    if (await runStackCommand(command, rest)) {
      return Number(process.exitCode ?? 0);
    }

    console.error(USAGE);
    return 2;
  }

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(rest);
  } catch (error) {
    console.error(`${String(error)}\n\n${USAGE}`);
    return 2;
  }

  try {
    return await run(command, parsed.values, parsed.positionals);
  } catch (error) {
    if (error instanceof SimUnreachableError && command === "status") {
      print(parsed.values.json === true, { up: false }, [error.message]);
      return 1;
    }

    let message = String(error);
    if (error instanceof Error) {
      message = error.message;
    }

    console.error(message);
    return 1;
  }
}

process.exit(await main(Bun.argv.slice(2)));
