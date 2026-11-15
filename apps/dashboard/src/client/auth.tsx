/** @jsxImportSource hono/jsx/dom */
import type { TOption } from "@bellaclaw/shared";
import { useRef, useState } from "hono/jsx/dom";
import type { TMeResponse } from "../api-types";
import { api } from "./api";

type TAuthCardProps = {
  // the link to redeem; without one only a login is possible
  token: TOption<string>;
  onAuthenticated: (me: TMeResponse) => void;
};

export function AuthCard({ token, onAuthenticated }: TAuthCardProps) {
  const [registering, setRegistering] = useState(token !== undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TOption<string>>(undefined);
  const form = useRef<HTMLFormElement>(null);

  async function submit(event: Event) {
    event.preventDefault();
    const data = new FormData(form.current ?? undefined);
    let path = "/api/login";

    if (registering) {
      path = "/api/register";
    }

    setBusy(true);
    setError(undefined);
    const result = await api<TMeResponse>("POST", path, {
      token,
      username: data.get("username"),
      password: data.get("password"),
    });

    if ("error" in result) {
      setBusy(false);
      setError(result.error);
      return;
    }

    onAuthenticated(result.data);
  }

  let intro = (
    <p class="muted">
      No account yet? Send <code>!dashboard</code> to the bot to create one.
    </p>
  );
  let fields = (
    <>
      <label class="field">
        <span>Username</span>
        <input name="username" autocomplete="username" autocapitalize="none" required />
      </label>
      <label class="field">
        <span>Password</span>
        <input name="password" type="password" autocomplete="current-password" required />
      </label>
    </>
  );
  let submitLabel = "Log in";

  if (token !== undefined) {
    intro = (
      <>
        <p class="muted">Create an account or log in to connect this chat.</p>
        <div class="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={String(registering)}
            onClick={() => setRegistering(true)}
          >
            Create account
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={String(!registering)}
            onClick={() => setRegistering(false)}
          >
            Log in
          </button>
        </div>
      </>
    );
  }

  if (registering) {
    fields = (
      <>
        <label class="field">
          <span>Username</span>
          <input
            name="username"
            autocomplete="username"
            autocapitalize="none"
            pattern="[A-Za-z0-9_.\-]{3,32}"
            required
          />
          <small>3 to 32 characters: letters, digits, _ . -</small>
        </label>
        <label class="field">
          <span>Password</span>
          <input
            name="password"
            type="password"
            autocomplete="new-password"
            minlength={10}
            maxlength={256}
            required
          />
          <small>At least 10 characters</small>
        </label>
      </>
    );
    submitLabel = "Create account";
  }

  return (
    <section class="card">
      <h1>BellaClaw</h1>
      {intro}
      <form class="stack" ref={form} onSubmit={submit}>
        {fields}
        {error !== undefined && (
          <p class="alert" role="alert">
            {error}
          </p>
        )}
        <button class="button" type="submit" disabled={busy}>
          {submitLabel}
        </button>
      </form>
    </section>
  );
}
