import { lookup } from "node:dns/promises";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import type { TOption } from "@bellaclaw/shared";

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
const NON_PUBLIC_IP_ADDRESSES = new BlockList();
const PUBLIC_IPV6_ADDRESSES = new BlockList();

NON_PUBLIC_IP_ADDRESSES.addSubnet("0.0.0.0", 8, "ipv4");
NON_PUBLIC_IP_ADDRESSES.addSubnet("10.0.0.0", 8, "ipv4");
NON_PUBLIC_IP_ADDRESSES.addSubnet("100.64.0.0", 10, "ipv4");
NON_PUBLIC_IP_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
NON_PUBLIC_IP_ADDRESSES.addSubnet("169.254.0.0", 16, "ipv4");
NON_PUBLIC_IP_ADDRESSES.addSubnet("172.16.0.0", 12, "ipv4");
NON_PUBLIC_IP_ADDRESSES.addSubnet("192.0.0.0", 24, "ipv4");
NON_PUBLIC_IP_ADDRESSES.addSubnet("192.0.2.0", 24, "ipv4");
NON_PUBLIC_IP_ADDRESSES.addSubnet("192.88.99.0", 24, "ipv4");
NON_PUBLIC_IP_ADDRESSES.addSubnet("192.168.0.0", 16, "ipv4");
NON_PUBLIC_IP_ADDRESSES.addSubnet("198.18.0.0", 15, "ipv4");
NON_PUBLIC_IP_ADDRESSES.addSubnet("198.51.100.0", 24, "ipv4");
NON_PUBLIC_IP_ADDRESSES.addSubnet("203.0.113.0", 24, "ipv4");
NON_PUBLIC_IP_ADDRESSES.addSubnet("224.0.0.0", 4, "ipv4");
NON_PUBLIC_IP_ADDRESSES.addSubnet("240.0.0.0", 4, "ipv4");

PUBLIC_IPV6_ADDRESSES.addSubnet("2000::", 3, "ipv6");
NON_PUBLIC_IP_ADDRESSES.addSubnet("2001::", 23, "ipv6");
NON_PUBLIC_IP_ADDRESSES.addSubnet("2001:db8::", 32, "ipv6");
NON_PUBLIC_IP_ADDRESSES.addSubnet("2002::", 16, "ipv6");
NON_PUBLIC_IP_ADDRESSES.addSubnet("3fff::", 20, "ipv6");

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

  if (isIP(hostname) !== 0 && !isPublicIpAddress(hostname)) {
    throw new Error("Private or reserved IP addresses are blocked");
  }

  return url.href;
}

export async function fetchTextWithLimit(args: {
  url: string;
  timeoutMs: number;
  maxBytes: number;
  headers?: THttpHeaders;
  signal?: AbortSignal;
  followRedirects?: boolean;
  validateResponseHeaders?: (response: Response) => void;
}): Promise<TFetchWithLimitResult> {
  args.signal?.throwIfAborted();
  let currentUrl = validatePublicHttpUrl(args.url);
  let redirects = 0;
  const deadline = performance.now() + args.timeoutMs;

  while (true) {
    const resolved = await validateResolvedPublicHttpUrl(
      currentUrl,
      getRemainingTimeoutMs(deadline),
      args.signal,
    );
    currentUrl = resolved.href;

    const response = await fetchResolvedHttpUrl({
      resolved,
      timeoutMs: getRemainingTimeoutMs(deadline),
      headers: args.headers,
      signal: args.signal,
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
  signal?: AbortSignal,
): Promise<TResolvedHttpUrl> {
  signal?.throwIfAborted();
  const href = validatePublicHttpUrl(rawUrl);

  if (globalThis.fetch !== DEFAULT_FETCH) {
    return {
      href,
      address: "",
    };
  }

  const url = new URL(href);
  const hostname = normalizeHostname(url.hostname);
  const addresses = await lookupWithCancellation(hostname, timeoutMs, signal);
  const address = addresses[0];

  if (address === undefined) {
    throw new Error("Hostname did not resolve to any IP address");
  }

  if (!isPublicIpAddress(address.address)) {
    throw new Error("Hostname resolves to a private or reserved IP address");
  }

  return {
    href,
    address: address.address,
  };
}

function lookupWithCancellation(
  hostname: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ address: string }[]> {
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(() => reject(new Error("Request timed out")));
    }, timeoutMs);
    const onAbort = () => {
      finish(() => reject(signal?.reason ?? new DOMException("aborted", "AbortError")));
    };
    const finish = (settle: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    lookup(hostname, { all: true }).then(
      (addresses) => finish(() => resolve(addresses)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function fetchResolvedHttpUrl(args: {
  resolved: TResolvedHttpUrl;
  timeoutMs: number;
  headers?: THttpHeaders;
  signal?: AbortSignal;
}): Promise<Response> {
  if (globalThis.fetch !== DEFAULT_FETCH) {
    return await fetch(args.resolved.href, {
      headers: createBrowserHeaders(args.headers),
      redirect: "manual",
      signal: combineAbortSignals(args.signal, AbortSignal.timeout(args.timeoutMs)),
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
    const abort = () => request.destroy(new Error("Operation aborted"));
    args.signal?.addEventListener("abort", abort, { once: true });
    request.on("error", reject);
    request.on("close", () => args.signal?.removeEventListener("abort", abort));
    request.end();
  });
}

function combineAbortSignals(signal: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  if (signal === undefined) {
    return timeout;
  }

  return AbortSignal.any([signal, timeout]);
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

function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) {
    return !NON_PUBLIC_IP_ADDRESSES.check(address, "ipv4");
  }

  if (family === 6) {
    return (
      PUBLIC_IPV6_ADDRESSES.check(address, "ipv6") &&
      !NON_PUBLIC_IP_ADDRESSES.check(address, "ipv6")
    );
  }

  return false;
}
