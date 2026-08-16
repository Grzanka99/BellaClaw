import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TOption } from "@bellaclaw/shared";
import { repositoryPath } from "@bellaclaw/shared";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_AGGREGATE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_PAGES = 20;
const MAX_ITEMS = 50_000;
const CREDENTIALS_FILE = repositoryPath(".secrets/google-calendar-service-account.json");
const GWS_BINARY = repositoryPath("node_modules/.bin/gws");

export type TGwsRequest = {
  resource: "events";
  method: "list" | "get" | "insert" | "patch" | "delete";
  params: Record<string, unknown>;
  body: TOption<Record<string, unknown>>;
  signal: TOption<AbortSignal>;
};

export type TGwsRunner = (request: TGwsRequest) => Promise<unknown>;

export function gwsEnvironment(): Record<string, TOption<string>> {
  const env = { ...Bun.env };
  delete env.GOOGLE_WORKSPACE_CLI_TOKEN;
  delete env.GOOGLE_WORKSPACE_CLI_CREDENTIALS;
  delete env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
  delete env.GOOGLE_WORKSPACE_CLI_CLIENT_ID;
  delete env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET;
  delete env.GOOGLE_WORKSPACE_CLI_ACCOUNT;
  delete env.GOOGLE_WORKSPACE_CLI_IMPERSONATED_USER;
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  delete env.GOOGLE_OAUTH_ACCESS_TOKEN;
  env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = CREDENTIALS_FILE;
  return env;
}

export async function createGwsWorkingDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bellaclaw-gws-"));
  try {
    await writeFile(join(directory, ".env"), "", { flag: "wx" });
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function decodeStructuredOutput(output: string): unknown {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const values: unknown[] = [];
    for (const line of trimmed.split("\n")) {
      if (line.trim().length > 0) {
        values.push(JSON.parse(line));
      }
    }
    return values;
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, maximum: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";

  while (true) {
    const result = await reader.read();
    if (result.done) {
      output += decoder.decode();
      return output;
    }

    bytes += result.value.byteLength;
    if (bytes > maximum) {
      await reader.cancel();
      throw new Error(`gws output exceeded ${maximum} bytes`);
    }
    output += decoder.decode(result.value, { stream: true });
  }
}

export const runGws: TGwsRunner = async (request) => {
  const argv = [
    GWS_BINARY,
    "calendar",
    request.resource,
    request.method,
    "--params",
    JSON.stringify(request.params),
  ];
  if (request.body !== undefined) {
    argv.push("--json", JSON.stringify(request.body));
  }

  const cwd = await createGwsWorkingDirectory();
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(argv, {
      cwd,
      env: gwsEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, TIMEOUT_MS);
  const abort = () => child.kill();
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) {
    child.kill();
  }

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBounded(child.stdout, MAX_OUTPUT_BYTES),
      readBounded(child.stderr, 64 * 1024),
    ]);
    if (timedOut) {
      throw new Error(`gws timed out after ${TIMEOUT_MS}ms`);
    }
    if (request.signal?.aborted) {
      throw new Error("gws request was cancelled");
    }
    if (exitCode !== 0) {
      const detail = stderr.trim().replaceAll(CREDENTIALS_FILE, "[credentials file]");
      if (detail.length > 0) {
        throw new Error(`gws exited with code ${exitCode}: ${detail}`);
      }
      throw new Error(`gws exited with code ${exitCode}`);
    }
    return decodeStructuredOutput(stdout);
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abort);
    await rm(cwd, { recursive: true, force: true });
  }
};

function readPageToken(value: unknown): TOption<string> {
  if (typeof value !== "object" || value === null || !("nextPageToken" in value)) {
    return undefined;
  }
  if (typeof value.nextPageToken === "string") {
    return value.nextPageToken;
  }
  return undefined;
}

function readItems(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "items" in value &&
    Array.isArray(value.items)
  ) {
    return value.items;
  }
  return [];
}

function readStringProperty(value: unknown, key: string): TOption<string> {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = Reflect.get(value, key);
  if (typeof candidate === "string") {
    return candidate;
  }
  return undefined;
}

export class GwsCalendarClient {
  public constructor(private runner: TGwsRunner = runGws) {}

  public async probeCalendar(
    calendarId: string,
    signal?: AbortSignal,
  ): Promise<{ accessRole: TOption<string>; summary: TOption<string> }> {
    const value = await this.runner({
      resource: "events",
      method: "list",
      params: { calendarId, maxResults: 1 },
      body: undefined,
      signal,
    });
    return {
      accessRole: readStringProperty(value, "accessRole"),
      summary: readStringProperty(value, "summary"),
    };
  }

  public async listEvents(
    calendarId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ accessRole: TOption<string>; summary: TOption<string>; items: unknown[] }> {
    const items: unknown[] = [];
    let pageToken: TOption<string>;
    let accessRole: TOption<string>;
    let summary: TOption<string>;
    let aggregateBytes = 0;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const pageParams: Record<string, unknown> = { ...params, calendarId };
      if (pageToken !== undefined) {
        pageParams.pageToken = pageToken;
      }
      const value = await this.runner({
        resource: "events",
        method: "list",
        params: pageParams,
        body: undefined,
        signal,
      });
      aggregateBytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (aggregateBytes > MAX_AGGREGATE_BYTES) {
        throw new Error(`gws aggregate result exceeded ${MAX_AGGREGATE_BYTES} bytes`);
      }
      items.push(...readItems(value));
      if (items.length > MAX_ITEMS) {
        throw new Error(`gws result exceeded ${MAX_ITEMS} items`);
      }
      if (typeof value === "object" && value !== null) {
        if ("accessRole" in value && typeof value.accessRole === "string") {
          accessRole = value.accessRole;
        }
        if ("summary" in value && typeof value.summary === "string") {
          summary = value.summary;
        }
      }
      pageToken = readPageToken(value);
      if (pageToken === undefined) {
        return { accessRole, summary, items };
      }
    }
    throw new Error(`gws pagination exceeded ${MAX_PAGES} pages`);
  }

  public getEvent(calendarId: string, eventId: string, signal?: AbortSignal): Promise<unknown> {
    return this.runner({
      resource: "events",
      method: "get",
      params: { calendarId, eventId },
      body: undefined,
      signal,
    });
  }

  public insertEvent(
    calendarId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.runner({
      resource: "events",
      method: "insert",
      params: { calendarId },
      body,
      signal,
    });
  }

  public patchEvent(
    calendarId: string,
    eventId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.runner({
      resource: "events",
      method: "patch",
      params: { calendarId, eventId },
      body,
      signal,
    });
  }

  public deleteEvent(calendarId: string, eventId: string, signal?: AbortSignal): Promise<unknown> {
    return this.runner({
      resource: "events",
      method: "delete",
      params: { calendarId, eventId },
      body: undefined,
      signal,
    });
  }
}
