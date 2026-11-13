/** @jsxImportSource hono/jsx/dom */
import type { TOption } from "@bellaclaw/shared";
import { render, useEffect, useState } from "hono/jsx/dom";
import type { TLinkCheckResponse, TMeResponse } from "../api-types";
import { api } from "./api";
import { AuthCard } from "./auth";
import { Dashboard } from "./dashboard";

type TView =
  | { name: "loading" }
  | { name: "failed"; message: string }
  | { name: "invalidLink" }
  // token: the link that the registration or login redeems
  | { name: "auth"; token: TOption<string> }
  | { name: "main"; me: TMeResponse };

function App() {
  const [view, setView] = useState<TView>({ name: "loading" });

  function showMain(me: TMeResponse) {
    // the link token leaves the address bar
    history.replaceState(null, "", `/${location.hash}`);
    setView({ name: "main", me });
  }

  async function start() {
    let token: TOption<string>;

    if (location.pathname === "/link") {
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

    const linked = await api<TMeResponse>("POST", "/api/link", { token });

    if ("error" in linked) {
      if (linked.status === 400) {
        setView({ name: "invalidLink" });
      } else {
        setView({ name: "failed", message: linked.error });
      }

      return;
    }

    showMain(linked.data);
  }

  useEffect(() => {
    void start();
  }, []);

  if (view.name === "main") {
    return (
      <Dashboard me={view.me} onLoggedOut={() => setView({ name: "auth", token: undefined })} />
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
    card = (
      <section class="card">
        <h1>This link no longer works</h1>
        <p class="muted">
          It has expired or was already used. Send <code>!dashboard</code> to the bot to get a new
          one.
        </p>
        <a class="button outline" href="/">
          Go to the dashboard
        </a>
      </section>
    );
  } else if (view.name === "auth") {
    card = <AuthCard token={view.token} onAuthenticated={showMain} />;
  }

  return <main class="center">{card}</main>;
}

const root = document.getElementById("root");

if (root !== null) {
  render(<App />, root);
}
