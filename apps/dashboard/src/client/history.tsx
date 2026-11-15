/** @jsxImportSource hono/jsx/dom */
import type { TOption } from "@bellaclaw/shared";
import { useEffect, useRef, useState } from "hono/jsx/dom";
import type { TChatMessage, TMessageDeletedResponse, TMessagesResponse } from "../api-types";
import { api, chatPath } from "./api";

const AUTHOR_LABELS: Record<TChatMessage["author"], string> = {
  user: "You",
  assistant: "Assistant",
};

export function HistoryTab({ chatId }: { chatId: string }) {
  // newest first
  const [messages, setMessages] = useState<TChatMessage[]>([]);
  // the `before` of the next page; undefined after the last one
  const [nextBefore, setNextBefore] = useState<TOption<number>>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<TOption<string>>(undefined);
  // the message in the confirmation dialog
  const [doomed, setDoomed] = useState<TOption<TChatMessage>>(undefined);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<TOption<string>>(undefined);
  const dialog = useRef<HTMLDialogElement>(null);

  async function load(before: TOption<number>) {
    let path = chatPath(chatId, "messages");

    if (before !== undefined) {
      path += `?before=${before}`;
    }

    setLoading(true);
    setError(undefined);
    const result = await api<TMessagesResponse>("GET", path);
    setLoading(false);

    if ("error" in result) {
      setError(result.error);
      return;
    }

    const page = result.data;
    setMessages((loaded) => [...loaded, ...page.messages]);
    setNextBefore(page.nextBefore);
  }

  useEffect(() => {
    void load(undefined);
  }, []);

  async function deleteMessage(message: TChatMessage) {
    setDeleting(true);
    setDeleteError(undefined);
    const result = await api<TMessageDeletedResponse>(
      "DELETE",
      chatPath(chatId, `messages/${message.id}`),
    );
    setDeleting(false);

    if ("error" in result) {
      setDeleteError(result.error);
      return;
    }

    const deletedIds = new Set(result.data.deletedMessageIds);
    setMessages((loaded) => loaded.filter((candidate) => !deletedIds.has(candidate.id)));
    dialog.current?.close();
  }

  return (
    <>
      {messages.length > 0 && (
        <section class="card messages">
          {messages.map((message) => (
            <article class="message" key={message.id}>
              <div class="message-meta">
                <span class={`badge ${message.author}`}>{AUTHOR_LABELS[message.author]}</span>
                <time class="muted">{new Date(message.createdAt).toLocaleString()}</time>
                <button
                  class="button ghost small"
                  type="button"
                  onClick={() => {
                    setDoomed(message);
                    setDeleteError(undefined);
                    dialog.current?.showModal();
                  }}
                >
                  Delete
                </button>
              </div>
              <p class="text">{message.text}</p>
            </article>
          ))}
        </section>
      )}
      {!loading && error === undefined && messages.length === 0 && (
        <p class="muted">No messages in this chat yet.</p>
      )}
      {error !== undefined && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}
      {loading && <p class="muted">Loading…</p>}
      {!loading && nextBefore !== undefined && (
        <div>
          <button class="button outline" type="button" onClick={() => void load(nextBefore)}>
            Load older
          </button>
        </div>
      )}
      <dialog ref={dialog} onClose={() => setDoomed(undefined)}>
        {doomed !== undefined && (
          <div class="stack">
            <h2>Delete this message?</h2>
            <p class="text quote muted">{doomed.text}</p>
            <p>
              The message is removed from the bot's context, and facts learned from it are
              forgotten. An existing summary of older conversation may still contain it.
            </p>
            {deleteError !== undefined && (
              <p class="alert" role="alert">
                {deleteError}
              </p>
            )}
            <div class="row">
              <button
                class="button outline"
                type="button"
                disabled={deleting}
                onClick={() => dialog.current?.close()}
              >
                Cancel
              </button>
              <button
                class="button destructive"
                type="button"
                disabled={deleting}
                onClick={() => void deleteMessage(doomed)}
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
