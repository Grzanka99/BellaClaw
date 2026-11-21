/** @jsxImportSource hono/jsx/dom */
import type { TOption } from "@bellaclaw/shared";
import { useEffect, useState } from "hono/jsx/dom";
import type { TGatewayPersonality, TGatewayPersonalityUpdate } from "../api-types";
import { api } from "./api";

type TPersonalityTabProps = {
  // only the fields the user edited, kept by the parent so a remount keeps unsaved edits; every
  // other field shows the saved settings
  draft: TGatewayPersonalityUpdate;
  // changes the latest draft
  setDraft: (change: (draft: TGatewayPersonalityUpdate) => TGatewayPersonalityUpdate) => void;
};

// the draft's fields that differ from values: an edit that holds the same value is none
function differing(
  draft: TGatewayPersonalityUpdate,
  values: TGatewayPersonalityUpdate,
): TGatewayPersonalityUpdate {
  const rest: TGatewayPersonalityUpdate = {};

  if (draft.bellaPersona !== undefined && draft.bellaPersona !== values.bellaPersona) {
    rest.bellaPersona = draft.bellaPersona;
  }

  if (
    draft.plainChatsUseBellaPersona !== undefined &&
    draft.plainChatsUseBellaPersona !== values.plainChatsUseBellaPersona
  ) {
    rest.plainChatsUseBellaPersona = draft.plainChatsUseBellaPersona;
  }

  if (
    draft.plainChatsPersona !== undefined &&
    draft.plainChatsPersona !== values.plainChatsPersona
  ) {
    rest.plainChatsPersona = draft.plainChatsPersona;
  }

  return rest;
}

export function PersonalityTab({ draft, setDraft }: TPersonalityTabProps) {
  // what the assistant uses now
  const [saved, setSaved] = useState<TOption<TGatewayPersonality>>(undefined);
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState<TOption<string>>(undefined);

  async function request(method: string, update: TOption<TGatewayPersonalityUpdate>) {
    setBusy(true);
    setFailure(undefined);
    const result = await api<TGatewayPersonality>(method, "/api/personality", update);
    setBusy(false);

    if ("error" in result) {
      setFailure(result.error);
      return;
    }

    setSaved(result.data);

    // a save stored its edits, so their controls show what the assistant answered; an edit made
    // since the save began stays
    if (update !== undefined) {
      setDraft((latest) => differing(latest, update));
    }
  }

  useEffect(() => {
    void request("GET", undefined);
  }, []);

  if (saved === undefined) {
    if (failure !== undefined) {
      return (
        <p class="alert" role="alert">
          {failure}
        </p>
      );
    }

    return <p class="muted">Loading…</p>;
  }

  const loaded = saved;
  const shown: TGatewayPersonality = { ...saved, ...draft };
  // only the edits that differ from the saved settings, so an untouched control changes nothing
  const update = differing(draft, saved);

  // a control returned to its saved value is no edit
  function edit(change: TGatewayPersonalityUpdate) {
    setDraft((latest) => differing({ ...latest, ...change }, loaded));
  }

  let chatsHint = "Replaces BellaClaw's personality in chats. Empty: no personality. Optional.";

  if (shown.plainChatsUseBellaPersona) {
    chatsHint = "Added after BellaClaw's personality. Optional.";
  }

  return (
    <section class="card">
      <h2>BellaClaw</h2>
      <label class="field">
        <span>BellaClaw's personality</span>
        <textarea
          rows={6}
          value={shown.bellaPersona}
          disabled={busy}
          onInput={(event: Event) => {
            if (event.target instanceof HTMLTextAreaElement) {
              edit({ bellaPersona: event.target.value });
            }
          }}
        />
      </label>
      <h2>Chats</h2>
      <label class="toggle">
        <input
          type="checkbox"
          checked={shown.plainChatsUseBellaPersona}
          disabled={busy}
          onChange={(event: Event) => {
            if (event.target instanceof HTMLInputElement) {
              edit({ plainChatsUseBellaPersona: event.target.checked });
            }
          }}
        />
        <span>Use BellaClaw's personality in chats</span>
      </label>
      <label class="field">
        <span>Chats personality</span>
        <textarea
          rows={3}
          value={shown.plainChatsPersona}
          disabled={busy}
          onInput={(event: Event) => {
            if (event.target instanceof HTMLTextAreaElement) {
              edit({ plainChatsPersona: event.target.value });
            }
          }}
        />
        <small>{chatsHint}</small>
      </label>
      {failure !== undefined && (
        <p class="alert" role="alert">
          {failure}
        </p>
      )}
      <div class="row">
        <button
          class="button"
          type="button"
          disabled={busy || Object.keys(update).length === 0}
          onClick={() => void request("PUT", update)}
        >
          Save
        </button>
      </div>
    </section>
  );
}
