import type { DAVCalendar } from "tsdav";

export function requestOptions(signal?: AbortSignal): RequestInit {
  const timeout = AbortSignal.timeout(30_000);
  if (signal !== undefined) {
    return { signal: AbortSignal.any([signal, timeout]) };
  }
  return { signal: timeout };
}

export function assertResponse(response: Response, operation: string): void {
  if (!response.ok) {
    if (response.status === 412) {
      throw new Error("iCloud event changed since it was read; list events again before retrying");
    }
    throw new Error(`iCloud ${operation} failed (HTTP ${response.status})`);
  }
}

export function resourceFilename(calendar: DAVCalendar, url: string): string {
  const objectUrl = new URL(url);
  const base = new URL(calendar.url);
  const filename = objectUrl.pathname.slice(base.pathname.length);
  if (
    objectUrl.origin !== base.origin ||
    !objectUrl.pathname.startsWith(base.pathname) ||
    filename.length === 0 ||
    decodeURIComponent(filename).includes("/") ||
    decodeURIComponent(filename).includes("\\")
  ) {
    throw new Error("iCloud event resource is outside its calendar");
  }
  return filename;
}
