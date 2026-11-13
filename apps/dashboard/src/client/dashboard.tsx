/** @jsxImportSource hono/jsx/dom */
import type { TOption } from "@bellaclaw/shared";
import { useEffect, useState } from "hono/jsx/dom";
import type { TMeResponse } from "../api-types";
import { api, UNAUTHORIZED_EVENT } from "./api";
import { FactsTab } from "./facts";
import { HistoryTab } from "./history";
import { ModelTab } from "./model";
import { Select } from "./select";

type TTab = "model" | "history" | "facts";

const TABS: { id: TTab; label: string }[] = [
  { id: "model", label: "Model" },
  { id: "history", label: "History" },
  { id: "facts", label: "Facts" },
];
const CHAT_STORAGE_KEY = "bellaclaw.dashboard.chat";

// the tab named by the URL hash
function readTab(): TTab {
  return TABS.find((tab) => tab.id === location.hash.slice(1))?.id ?? "model";
}

type TDashboardProps = {
  me: TMeResponse;
  // after a logout, and when the session ended
  onLoggedOut: () => void;
};

export function Dashboard({ me, onLoggedOut }: TDashboardProps) {
  const [tab, setTab] = useState(readTab);
  const [chatId, setChatId] = useState<TOption<string>>(() => {
    let stored: TOption<string>;

    try {
      stored = localStorage.getItem(CHAT_STORAGE_KEY) ?? undefined;
    } catch {
      // storage is blocked
    }

    if (me.chats.some((chat) => chat.chatId === stored)) {
      return stored;
    }

    return me.chats[0]?.chatId;
  });

  useEffect(() => {
    const onHashChange = () => setTab(readTab());
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener(UNAUTHORIZED_EVENT, onLoggedOut);

    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener(UNAUTHORIZED_EVENT, onLoggedOut);
    };
  }, []);

  function selectChat(selected: string) {
    setChatId(selected);

    try {
      localStorage.setItem(CHAT_STORAGE_KEY, selected);
    } catch {
      // storage is blocked
    }
  }

  async function logOut() {
    await api("POST", "/api/logout");
    onLoggedOut();
  }

  let content = (
    <section class="card">
      <h2>No chats yet</h2>
      <p class="muted">
        Send <code>!dashboard</code> to the bot in a chat and open the link to connect that chat.
      </p>
    </section>
  );

  if (chatId !== undefined) {
    // the key gives every chat a tab of its own
    let panel = <ModelTab key={chatId} chatId={chatId} />;

    if (tab === "history") {
      panel = <HistoryTab key={chatId} chatId={chatId} />;
    } else if (tab === "facts") {
      panel = <FactsTab key={chatId} chatId={chatId} />;
    }

    content = (
      <>
        <div class="tabs" role="tablist">
          {TABS.map(({ id, label }) => (
            <a role="tab" href={`#${id}`} aria-selected={String(id === tab)}>
              {label}
            </a>
          ))}
        </div>
        {panel}
      </>
    );
  }

  return (
    <>
      <header class="header">
        <div class="page header-row">
          <h1>BellaClaw</h1>
          {chatId !== undefined && (
            <Select
              label="Chat"
              value={chatId}
              options={me.chats.map((chat) => ({ value: chat.chatId, label: chat.chatId }))}
              onChange={selectChat}
            />
          )}
          <div class="header-account">
            <span class="muted">{me.username}</span>
            <button class="button ghost" type="button" onClick={logOut}>
              Log out
            </button>
          </div>
        </div>
      </header>
      <main class="page stack">{content}</main>
    </>
  );
}
