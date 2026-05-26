export type TFetchWithLimitResult = {
  response: Response;
  text: string;
  url: string;
};

type THttpHeaders = Record<string, string>;

const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
} satisfies THttpHeaders;

const MAX_REDIRECTS = 5;

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
}): Promise<TFetchWithLimitResult> {
  let currentUrl = validatePublicHttpUrl(args.url);
  let redirects = 0;

  while (true) {
    const response = await fetch(currentUrl, {
      headers: createBrowserHeaders(args.headers),
      redirect: "manual",
      signal: AbortSignal.timeout(args.timeoutMs),
    });

    if (isRedirect(response.status)) {
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
      const parsedLength = Number(contentLength);

      if (Number.isFinite(parsedLength) && parsedLength > args.maxBytes) {
        throw new Error("Response is too large");
      }
    }

    return {
      response,
      text: await readResponseTextWithLimit(response, args.maxBytes),
      url: currentUrl,
    };
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    received += result.value.byteLength;

    if (received > maxBytes) {
      reader.cancel();
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

function parseIpv4(hostname: string): number[] | undefined {
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
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function expandIpv6(hostname: string): number[] | undefined {
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
    return left.length === 8 ? left : undefined;
  }

  const missing = 8 - left.length - right.length;

  if (missing < 0) {
    return undefined;
  }

  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIpv6Hextets(value: string): number[] | undefined {
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

  const allButLastZero = parts.slice(0, 7).every((part) => part === 0);
  const isMappedIpv4 = parts.slice(0, 5).every((part) => part === 0) && sixth === 0xffff;

  if (isMappedIpv4) {
    return isBlockedIpv4([seventh >> 8, seventh & 0xff, last >> 8, last & 0xff]);
  }

  return (
    (allButLastZero && last === 1) || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
  );
}
