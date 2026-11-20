/** @jsxImportSource hono/jsx/dom */
import { useEffect, useState } from "hono/jsx/dom";
import type { TGatewayPersonalityUpdate, TMeResponse } from "../api-types";
import { ACCOUNT_CHANGED_EVENT, api, UNAUTHORIZED_EVENT } from "./api";
import { FactsTab } from "./facts";
import { HistoryTab } from "./history";
import { ModelTab } from "./model";
import { PersonalityTab } from "./personality";

type TTab = "model" | "personality" | "history" | "facts";

// how often the account is read again while a link is being made
const LINKING_POLL_MS = 3_000;

const TABS: { id: TTab; label: string }[] = [
  { id: "model", label: "Model" },
  { id: "personality", label: "Personality" },
  { id: "history", label: "History" },
  { id: "facts", label: "Facts" },
];

// the tab named by the URL hash
function readTab(): TTab {
  return TABS.find((tab) => tab.id === location.hash.slice(1))?.id ?? "model";
}

type TDashboardProps = {
  me: TMeResponse;
  // after a logout, and when the session ended
  onLoggedOut: () => void;
  // when the session belongs to another account than me
  onAccountChanged: () => void;
};

export function Dashboard({ me: initialMe, onLoggedOut, onAccountChanged }: TDashboardProps) {
  const [tab, setTab] = useState(readTab);
  const [me, setMe] = useState(initialMe);
  // a new value mounts the visible tab again, which loads its data again
  const [panelVersion, setPanelVersion] = useState(0);
  // the Personality tab's unsaved edits, only the fields the user changed, kept while the tab
  // mounts again
  const [personalityDraft, setPersonalityDraft] = useState<TGatewayPersonalityUpdate>({});

  useEffect(() => {
    const onHashChange = () => setTab(readTab());
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener(UNAUTHORIZED_EVENT, onLoggedOut);
    window.addEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged);

    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener(UNAUTHORIZED_EVENT, onLoggedOut);
      window.removeEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged);
    };
  }, []);

  // while a link is being made the account is read again, and once none is the tab reloads
  useEffect(() => {
    if (!me.chats.some((chat) => chat.state === "migrating")) {
      return;
    }

    const timer = setTimeout(async () => {
      const result = await api<TMeResponse>("GET", "/api/me");

      if ("error" in result) {
        // the same state again schedules the next read
        setMe({ ...me });
        return;
      }

      setMe(result.data);

      if (!result.data.chats.some((chat) => chat.state === "migrating")) {
        setPanelVersion((version) => version + 1);
      }
    }, LINKING_POLL_MS);

    return () => clearTimeout(timer);
  }, [me]);

  async function logOut() {
    const result = await api("POST", "/api/logout");

    // the session of another account stays, and the page renders again for it
    if ("error" in result && result.status === 409) {
      return;
    }

    onLoggedOut();
  }

  // the personality belongs to the account, so an account with no chat has it too
  let content = (
    <>
      <section class="card">
        <h2>No chats yet</h2>
        <p class="muted">
          Send <code>!dashboard</code> to the bot in a chat and open the link to connect that chat.
        </p>
      </section>
      <PersonalityTab draft={personalityDraft} setDraft={setPersonalityDraft} />
    </>
  );

  if (me.chats.length > 0) {
    let panel = <ModelTab key={panelVersion} />;

    if (tab === "personality") {
      panel = (
        <PersonalityTab
          key={panelVersion}
          draft={personalityDraft}
          setDraft={setPersonalityDraft}
        />
      );
    } else if (tab === "history") {
      panel = <HistoryTab key={panelVersion} />;
    } else if (tab === "facts") {
      panel = <FactsTab key={panelVersion} />;
    }

    content = (
      <>
        <div class="row">
          {me.chats.map((chat) => {
            let state = "linked";

            if (chat.state === "migrating") {
              state = "linking…";
            }

            return (
              <span class="badge">
                {chat.chatKey} · {state}
              </span>
            );
          })}
        </div>
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
