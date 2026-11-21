import type { TOption } from "@bellaclaw/shared";
import { ACCOUNT_HEADER } from "../account-header";
import type { TApiError } from "../api-types";

// Dispatched on window for every 401 answer. The main view listens and returns to the login card.
export const UNAUTHORIZED_EVENT = "bellaclaw:unauthorized";

// Dispatched on window when the session belongs to another account than the page shows. The main
// view listens and renders the page again for whoever is signed in.
export const ACCOUNT_CHANGED_EVENT = "bellaclaw:account-changed";

// the username the page shows, sent in the account header while set
let shownAccount: TOption<string>;

export function showAccount(username: TOption<string>) {
  shownAccount = username;
}

// status 0 is no answer at all
export type TApiResult<T> = { data: T } | { error: string; status: number };

// NOTE: no timeout. A model change waits minutes for the assistant's provider verification.
export async function api<T>(method: string, path: string, body?: unknown): Promise<TApiResult<T>> {
  try {
    const headers = new Headers({ "Content-Type": "application/json" });

    if (shownAccount !== undefined) {
      headers.set(ACCOUNT_HEADER, shownAccount);
    }

    const response = await fetch(path, { method, headers, body: JSON.stringify(body) });
    const payload = await response.json();

    if (response.ok) {
      return { data: payload };
    }

    if (response.status === 401) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }

    const failure: TApiError = payload;

    // the page no longer names an account, so the next read asks who is signed in
    if (failure.code === "otherAccount") {
      shownAccount = undefined;
      window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT));
    }

    return { error: failure.error, status: response.status };
  } catch {
    // no connection, or an answer that is not JSON
    return { error: "The dashboard is unreachable. Try again in a moment", status: 0 };
  }
}
