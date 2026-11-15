import type { TApiError } from "../api-types";

// Dispatched on window for every 401 answer. The main view listens and returns to the login card.
export const UNAUTHORIZED_EVENT = "bellaclaw:unauthorized";

// status 0 is no answer at all
export type TApiResult<T> = { data: T } | { error: string; status: number };

export function chatPath(chatId: string, route: string): string {
  return `/api/chats/${encodeURIComponent(chatId)}/${route}`;
}

// NOTE: no timeout. A model change waits minutes for the assistant's provider verification.
export async function api<T>(method: string, path: string, body?: unknown): Promise<TApiResult<T>> {
  try {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();

    if (response.ok) {
      return { data: payload };
    }

    if (response.status === 401) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }

    const failure: TApiError = payload;

    return { error: failure.error, status: response.status };
  } catch {
    // no connection, or an answer that is not JSON
    return { error: "The dashboard is unreachable. Try again in a moment", status: 0 };
  }
}
