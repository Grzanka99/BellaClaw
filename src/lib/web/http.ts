import { lookup } from "node:dns/promises";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { Readable } from "node:stream";
import type { TOption } from "../../types";

export type TFetchWithLimitResult = {
  response: Response;
  text: string;
  url: string;
};

type TResolvedHttpUrl = {
  href: string;
  address: TOption<string>;
};

type THttpHeaders = Record<string, string>;

const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
} satisfies THttpHeaders;

const MAX_REDIRECTS = 5;
const DEFAULT_FETCH = globalThis.fetch;

export function createBrowserHeaders(headers: THttpHeaders = {}): THttpHeaders {
  return {
    ...BROWSER_HEADERS,
    ...headers,
  };
}

export function validatePublicHttpUrl(rawUrl: string): string {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported");
  }

  const hostname = normalizeHostname(url.hostname);

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Localhost URLs are blocked");
  }

  if (isBlockedIpLiteral(hostname)) {
    throw new Error("Local or private IP literal URLs are blocked");
  }

  return url.href;
}

export async function fetchTextWithLimit(args: {
  url: string;
  timeoutMs: number;
  maxBytes: number;
  headers?: THttpHeaders;
  followRedirects?: boolean;
  validateResponseHeaders?: (response: Response) => void;
}): Promise<TFetchWithLimitResult> {
  let currentUrl = validatePublicHttpUrl(args.url);
  let redirects = 0;
  const deadline = performance.now() + args.timeoutMs;

  while (true) {
    const resolved = await validateResolvedPublicHttpUrl(
      currentUrl,
      getRemainingTimeoutMs(deadline),
    );
    currentUrl = resolved.href;

    const response = await fetchResolvedHttpUrl({
      resolved,
      timeoutMs: getRemainingTimeoutMs(deadline),
      headers: args.headers,
    });

    if (response.status >= 300 && response.status < 400) {
      if (args.followRedirects !== true) {
        throw new Error("Redirect responses are not supported for this request");
      }

      if (redirects >= MAX_REDIRECTS) {
        throw new Error("Too many redirects");
      }

      const location = response.headers.get("location");

      if (location === null) {
        throw new Error("Redirect response is missing Location header");
      }

      currentUrl = validatePublicHttpUrl(new URL(location, currentUrl).href);
      redirects += 1;
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP request failed with status ${response.status}`);
    }

    const contentLength = response.headers.get("content-length");

    if (contentLength !== null) {
      const normalizedContentLength = contentLength.trim();

      if (/^\d+$/.test(normalizedContentLength)) {
        const parsedLength = Number.parseInt(normalizedContentLength, 10);

        if (Number.isFinite(parsedLength) && parsedLength > args.maxBytes) {
          throw new Error("Response is too large");
        }
      }
    }

    args.validateResponseHeaders?.(response);

    return {
      response,
      text: await readResponseTextWithLimit(response, args.maxBytes, deadline),
      url: currentUrl,
    };
  }
}

async function validateResolvedPublicHttpUrl(
  rawUrl: string,
  timeoutMs: number,
): Promise<TResolvedHttpUrl> {
  const href = validatePublicHttpUrl(rawUrl);

  if (globalThis.fetch !== DEFAULT_FETCH) {
    return {
      href,
      address: "",
    };
  }

  const url = new URL(href);
  const hostname = normalizeHostname(url.hostname);
  const addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise<{ address: string }[]>((_, reject) => {
      AbortSignal.timeout(timeoutMs).addEventListener(
        "abort",
        () => {
          reject(new Error("Request timed out"));
        },
        { once: true },
      );
    }),
  ]);
  const address = addresses[0];

  if (address === undefined) {
    throw new Error("Hostname did not resolve to any IP address");
  }

  for (const address of addresses) {
    if (isBlockedIpLiteral(normalizeHostname(address.address))) {
      throw new Error("Hostname resolves to a local, private, or special-use IP address");
    }
  }

  return {
    href,
    address: address.address,
  };
}

async function fetchResolvedHttpUrl(args: {
  resolved: TResolvedHttpUrl;
  timeoutMs: number;
  headers?: THttpHeaders;
}): Promise<Response> {
  if (globalThis.fetch !== DEFAULT_FETCH) {
    return await fetch(args.resolved.href, {
      headers: createBrowserHeaders(args.headers),
      redirect: "manual",
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  }

  return await new Promise<Response>((resolve, reject) => {
    const url = new URL(args.resolved.href);
    const address = args.resolved.address;

    if (address === undefined) {
      reject(new Error("Resolved request is missing pinned IP address"));
      return;
    }

    let port: number;

    if (url.port !== "") {
      port = Number(url.port);
    } else if (url.protocol === "https:") {
      port = 443;
    } else {
      port = 80;
    }

    const requestOptions = {
      hostname: address,
      port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: createPinnedRequestHeaders(url, args.headers),
    };
    const handleResponse = (response: IncomingMessage) => {
      const status = response.statusCode;

      if (status === undefined) {
        reject(new Error("HTTP response is missing status code"));
        return;
      }

      try {
        resolve(
          new Response(Readable.toWeb(response), {
            status,
            statusText: response.statusMessage,
            headers: createResponseHeaders(response.headers),
          }),
        );
      } catch (error) {
        reject(error);
      }
    };
    let request: ClientRequest;

    if (url.protocol === "https:") {
      request = requestHttps(
        {
          ...requestOptions,
          servername: normalizeHostname(url.hostname),
        },
        handleResponse,
      );
    } else {
      request = requestHttp(requestOptions, handleResponse);
    }

    request.setTimeout(args.timeoutMs, () => {
      request.destroy(new Error("Request timed out"));
    });
    request.on("error", reject);
    request.end();
  });
}

function createPinnedRequestHeaders(url: URL, headers: THttpHeaders = {}): THttpHeaders {
  const requestHeaders = createBrowserHeaders(headers);

  for (const key of Object.keys(requestHeaders)) {
    if (key.toLowerCase() === "host") {
      delete requestHeaders[key];
    }
  }

  return {
    ...requestHeaders,
    host: url.host,
  };
}

function createResponseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(name, item);
      }

      continue;
    }

    result.append(name, value);
  }

  return result;
}

function getRemainingTimeoutMs(deadline: number): number {
  const remaining = Math.ceil(deadline - performance.now());

  if (remaining <= 0) {
    throw new Error("Request timed out");
  }

  return remaining;
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  deadline: number,
): Promise<string> {
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  function cancelReader(): void {
    void reader.cancel().catch(() => undefined);
  }

  async function readChunkWithDeadline() {
    let timeoutId: TOption<ReturnType<typeof setTimeout>>;
    let timedOut = false;
    const timeoutMs = getRemainingTimeoutMs(deadline);
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error("Request timed out"));
        cancelReader();
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([reader.read(), timeout]);

      if (timedOut) {
        throw new Error("Request timed out");
      }

      return result;
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  while (true) {
    const result = await readChunkWithDeadline();

    if (result.done) {
      break;
    }

    received += result.value.byteLength;

    if (received > maxBytes) {
      cancelReader();
      throw new Error("Response is too large");
    }

    chunks.push(result.value);
  }

  const body = new Uint8Array(received);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isBlockedIpLiteral(hostname: string): boolean {
  const ipv4 = parseIpv4(hostname);

  if (ipv4 !== undefined) {
    return isBlockedIpv4(ipv4);
  }

  const ipv4MappedPrefix = "::ffff:";

  if (hostname.startsWith(ipv4MappedPrefix)) {
    const mappedIpv4 = parseIpv4(hostname.slice(ipv4MappedPrefix.length));

    if (mappedIpv4 !== undefined) {
      return isBlockedIpv4(mappedIpv4);
    }
  }

  const ipv6 = expandIpv6(hostname);

  if (ipv6 === undefined) {
    return false;
  }

  return isBlockedIpv6(ipv6);
}

function parseIpv4(hostname: string): TOption<number[]> {
  const parts = hostname.split(".");

  if (parts.length !== 4) {
    return undefined;
  }

  const parsed: number[] = [];

  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return undefined;
    }

    const value = Number(part);

    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return undefined;
    }

    parsed.push(value);
  }

  return parsed;
}

function isBlockedIpv4(parts: number[]): boolean {
  const first = parts[0];
  const second = parts[1];

  if (first === undefined || second === undefined) {
    return false;
  }

  return (
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function expandIpv6(hostname: string): TOption<number[]> {
  if (!hostname.includes(":")) {
    return undefined;
  }

  const halves = hostname.split("::");

  if (halves.length > 2) {
    return undefined;
  }

  const left = parseIpv6Hextets(halves[0] ?? "");
  const right = parseIpv6Hextets(halves[1] ?? "");

  if (left === undefined || right === undefined) {
    return undefined;
  }

  if (halves.length === 1) {
    if (left.length === 8) {
      return left;
    }

    return undefined;
  }

  const missing = 8 - left.length - right.length;

  if (missing < 0) {
    return undefined;
  }

  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIpv6Hextets(value: string): TOption<number[]> {
  if (value === "") {
    return [];
  }

  const parsed: number[] = [];

  for (const part of value.split(":")) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) {
      return undefined;
    }

    parsed.push(Number.parseInt(part, 16));
  }

  return parsed;
}

function isBlockedIpv6(parts: number[]): boolean {
  const first = parts[0];
  const sixth = parts[5];
  const seventh = parts[6];
  const last = parts[7];

  if (first === undefined || sixth === undefined || seventh === undefined || last === undefined) {
    return false;
  }

  const allZero = parts.every((part) => part === 0);
  const allButLastZero = parts.slice(0, 7).every((part) => part === 0);
  const isMappedIpv4 = parts.slice(0, 5).every((part) => part === 0) && sixth === 0xffff;

  if (isMappedIpv4) {
    return isBlockedIpv4([seventh >> 8, seventh & 0xff, last >> 8, last & 0xff]);
  }

  return (
    allZero ||
    (allButLastZero && last === 1) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80
  );
}
