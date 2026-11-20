/** @jsxImportSource hono/jsx/dom */
import type { TOption } from "@bellaclaw/shared";
import { render, useEffect, useState } from "hono/jsx/dom";
import type { TLinkCheckResponse, TMeResponse } from "../api-types";
import { api, showAccount } from "./api";
import { AppLinkCard, AuthCard, LinkLoginCard } from "./auth";
import { Dashboard } from "./dashboard";

type TView =
  | { name: "loading" }
  | { name: "failed"; message: string }
  | { name: "invalidLink" }
  // token: the link of the !app page, which the app redeems
  | { name: "appLink"; token: string }
  // token: the link that the registration or login redeems
  | { name: "auth"; token: TOption<string> }
  // token: a link of a chat linked to the account of username, which logs into it
  | { name: "linkLogin"; token: string; username: string }
  // token: a link of the unlinked chat chatKey, which the signed-in account takes once confirmed;
  // error: why the last confirmation was refused
  | { name: "confirmLink"; token: string; chatKey: string; me: TMeResponse; error?: string }
  | { name: "main"; me: TMeResponse };

function App() {
  const [view, setView] = useState<TView>({ name: "loading" });
  const [busy, setBusy] = useState(false);

  function showMain(me: TMeResponse) {
    // the link token leaves the address bar
    history.replaceState(null, "", `/${location.hash}`);
    setView({ name: "main", me });
  }

  async function start() {
    let token: TOption<string>;
    let chatKey = "";

    if (location.pathname === "/link" || location.pathname === "/app") {
      token = new URLSearchParams(location.search).get("token") ?? "";
      const check = await api<TLinkCheckResponse>("POST", "/api/link/check", { token });

      if ("error" in check) {
        setView({ name: "failed", message: check.error });
        return;
      }

      if (!check.data.valid) {
        setView({ name: "invalidLink" });
        return;
      }

      if (location.pathname === "/app") {
        setView({ name: "appLink", token });
        return;
      }

      if (check.data.username !== undefined) {
        setView({ name: "linkLogin", token, username: check.data.username });
        return;
      }

      chatKey = check.data.chatKey;
    }

    const me = await api<TMeResponse>("GET", "/api/me");

    if ("error" in me) {
      if (me.status === 401) {
        setView({ name: "auth", token });
      } else {
        setView({ name: "failed", message: me.error });
      }

      return;
    }

    if (token === undefined) {
      setView({ name: "main", me: me.data });
      return;
    }

    // NOTE: a linked address signs into its account for good, so nothing is sent before the
    // confirmation
    setView({ name: "confirmLink", token, chatKey, me: me.data });
  }

  // the page again for whoever is signed in now
  async function showSignedIn() {
    // NOTE: the controls of the account shown so far go first, so none of them acts on this one
    setView({ name: "loading" });
    const me = await api<TMeResponse>("GET", "/api/me");

    if (!("error" in me)) {
      setView({ name: "main", me: me.data });
    } else if (me.status === 401) {
      setView({ name: "auth", token: undefined });
    } else {
      setView({ name: "failed", message: me.error });
    }
  }

  async function confirmLink(token: string, chatKey: string) {
    setBusy(true);
    const linked = await api<TMeResponse>("POST", "/api/link", { token });

    if ("error" in linked) {
      if (linked.status === 400) {
        setBusy(false);
        setView({ name: "invalidLink" });
        return;
      }

      if (linked.status !== 409) {
        setBusy(false);
        setView({ name: "failed", message: linked.error });
        return;
      }

      // the card shows the error with whoever is signed in now
      const me = await api<TMeResponse>("GET", "/api/me");
      setBusy(false);

      if (!("error" in me)) {
        setView({ name: "confirmLink", token, chatKey, me: me.data, error: linked.error });
      } else if (me.status === 401) {
        setView({ name: "auth", token });
      } else {
        setView({ name: "failed", message: me.error });
      }

      return;
    }

    setBusy(false);

    showMain(linked.data);
  }

  useEffect(() => {
    void start();
  }, []);

  // every request names the account the page shows
  if (view.name === "main" || view.name === "confirmLink") {
    showAccount(view.me.username);
  } else {
    showAccount(undefined);
  }

  if (view.name === "main") {
    return (
      <Dashboard
        key={view.me.username}
        me={view.me}
        onLoggedOut={() => setView({ name: "auth", token: undefined })}
        onAccountChanged={showSignedIn}
      />
    );
  }

  let card = <p class="muted">Loading…</p>;

  if (view.name === "failed") {
    card = (
      <p class="alert" role="alert">
        {view.message}
      </p>
    );
  } else if (view.name === "invalidLink") {
    // the command that issues a link of the page's kind
    let command = "!dashboard";

    if (location.pathname === "/app") {
      command = "!app";
    }

    card = (
      <section class="card">
        <h1>This link no longer works</h1>
        <p class="muted">
          It has expired or was already used. Send <code>{command}</code> to the bot to get a new
          one.
        </p>
        <a class="button outline" href="/">
          Go to the dashboard
        </a>
      </section>
    );
  } else if (view.name === "appLink") {
    card = <AppLinkCard token={view.token} />;
  } else if (view.name === "auth") {
    card = <AuthCard token={view.token} onAuthenticated={showMain} />;
  } else if (view.name === "linkLogin") {
    card = <LinkLoginCard token={view.token} username={view.username} onAuthenticated={showMain} />;
  } else if (view.name === "confirmLink") {
    const { token, chatKey, me, error } = view;
    card = (
      <section class="card">
        <h1>Link this chat?</h1>
        <p class="muted">
          <strong>{chatKey}</strong> will be linked to your account <strong>{me.username}</strong>{" "}
          for good. The chat can then log into this account and set its password.
        </p>
        {error !== undefined && (
          <p class="alert" role="alert">
            {error}
          </p>
        )}
        <div class="row">
          <button
            class="button"
            type="button"
            disabled={busy}
            onClick={() => confirmLink(token, chatKey)}
          >
            Link to {me.username}
          </button>
          <button class="button outline" type="button" disabled={busy} onClick={() => showMain(me)}>
            Cancel
          </button>
        </div>
      </section>
    );
  }

  return <main class="center">{card}</main>;
}

const root = document.getElementById("root");

if (root !== null) {
  render(<App />, root);
}
