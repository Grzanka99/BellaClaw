# Dashboard

The dashboard is a web control panel for the people who chat with BellaClaw. Each user has an
account and sees only the chats linked to it. It is meant to be reachable from the internet behind
a TLS reverse proxy.

It lives in the `@bellaclaw/dashboard` workspace (`apps/dashboard`). The log viewer is a separate
app and stays private; see [Behavior Logs](behavior-logs.md).

## Setup

Set both variables in `.env`; the other dashboard variables have defaults (see
[Configuration](configuration.md#dashboard)):

```dotenv
BELLACLAW_DASHBOARD_PUBLIC_URL=https://dashboard.example.com
BELLACLAW_DASHBOARD_SECRET=
```

Generate the secret with:

```bash
openssl rand -base64 32
```

The assistant and the dashboard read the same two values. Without either of them, `!dashboard`
replies that the dashboard is not configured, and the dashboard process logs one line and exits
with code `0`. Without the secret, the assistant does not start its internal listener.

The dashboard also reads `TURSO_CONNECTION_URL` and `TURSO_AUTH_TOKEN` from `.env`.

### Compose

Compose starts the `dashboard` service with the other services, so `bun run server:init` and
`bun run server:update` cover it. It:

- publishes `127.0.0.1:8988`, for the reverse proxy on the same host
- reaches the assistant's internal listener at `http://bellaclaw:3081` on the Compose network
- keeps its own database in the `dashboard-data` volume
- restarts only on failure, so an unconfigured dashboard stays stopped
- follows a [self-update](deployment.md#self-update) within 30 seconds
- receives only the Turso credentials, the public URL and the secret from `.env`

The assistant publishes no port for the internal listener.

### Reverse Proxy

Bun serves plain HTTP. Terminate TLS in a reverse proxy and forward `443` to `127.0.0.1:8988`.

- The session cookie is `Secure`, so `BELLACLAW_DASHBOARD_PUBLIC_URL` must be HTTPS, or
  `http://localhost` in development.
- Changes from the browser are accepted only when its `Origin` matches the public URL. Use the
  exact origin users open. Requests of the app are exempt; see [The App](#the-app).
- Set the proxy's read timeout to at least 255 seconds. A model change waits while the assistant
  verifies the model with the provider, which can take minutes.
- Do not buffer `text/event-stream`: the app's live stream sends each event at once and a
  keep-alive every 25 seconds. Caddy streams it as is.

Example for Caddy:

```text
dashboard.example.com {
	reverse_proxy 127.0.0.1:8988 {
		transport http {
			read_timeout 255s
		}
	}
}
```

## Linking a Chat

1. Send `!dashboard` in the chat.
2. BellaClaw replies with `BELLACLAW_DASHBOARD_PUBLIC_URL/link?token=…`. The link works once and
   expires after 10 minutes.
3. Open it, then create an account or log in. The chat is linked to that account.

An account is created from a link, or in the app with the activation code.

One account can hold many chats. A chat belongs to one account at a time; the latest redeemed link
wins.

If you forget the password, send `!dashboard` again and create a new account. The chat moves to
it.

## The App

The Android app talks only to the dashboard and uses the same `/api` routes as the web client.

Its requests carry `Authorization: Bearer <token>`, or, to start a session,
`X-BellaClaw-Client: app`. They never use the cookie and need no `Origin`. Register, login and
link login then answer with the account and `token`, the bearer token of a new app session. An app
session has no idle expiry. `POST /api/logout` with the token ends it, and a new password set
through a login link ends it too.

Ways in:

- **Activation code**: `POST /api/register` with `username`, `password` and `activationCode`
  (`BELLACLAW_ACTIVATION_TOKEN`). The assistant checks the code; the dashboard never holds it. The
  account has no chat until one is linked. Without a configured code, registration by code answers
  `403`. After five wrong codes, registration by code is closed for everyone for 15 minutes.
- **Password**: `POST /api/login`.
- **`!app`**: BellaClaw replies with `BELLACLAW_DASHBOARD_PUBLIC_URL/app?token=…`, which works
  once and expires after 10 minutes. The page offers "Open in app", an Android intent link that
  opens `bellaclaw://login?server=<dashboard URL>&token=<token>` in the package
  `one.scary.bellaclaw` only, and that deep link as a code to copy. The app checks the token with `POST /api/link/check`. A linked chat logs in with
  `POST /api/link/login`, optionally setting a new password. An unlinked chat registers with
  `POST /api/register` and `token`, or is linked with `POST /api/login` and `token`, or with
  `POST /api/link` when signed in.

Conversations:

- `GET /api/conversations`: the account's Bella conversation first (`kind: "bella"`), then its
  plain chats (`kind: "plain"`), the latest active first: by their newest row, else their
  creation. Each has `conversationKey`, `kind`, `revision` and `rewriteRevision`; `lastMessage`,
  the newest row the app shows (as in history), once there is one; a plain chat also has
  `createdAt` (epoch ms) and, once written, `title`. An account with no message yet has
  revision 0. After a completed turn of an untitled plain chat, the account's Utility model writes
  its title (one line, at most 60 characters) from that turn's message and reply. The title raises
  the chat's revision, so the stream sends `changed` and the app reads the list again. A failed
  title call leaves the chat untitled, without a notice, until its next completed turn.
- `POST /api/conversations`: creates a plain chat and answers `{ conversationKey, createdAt }`.
  The chat is listed at once, empty, at revision 0. The assistant builds the key.
- `DELETE /api/conversations/:conversationKey`: deletes a plain chat with its history and summary,
  and answers `{ conversationKey }`. The Bella conversation cannot be deleted and answers 404 at
  once, like a conversation of another account. The delete waits behind a turn the chat is
  running.
- `GET /api/conversations/:conversationKey/messages`: the rows the app shows, oldest first, with
  `revision` and `rewriteRevision`. Messages and display rows (commands and their replies,
  notices, failure replies), never tool rows; each has `id`, `author`, `kind`, `channel`, `text`,
  `createdAt` and the app's `clientMessageId`. Without a cursor, the newest 50 rows; `before=<id>`
  pages older rows, `nextBefore` names the next older page; `after=<id>` returns the rows after the
  newest one the app has, `nextAfter` names the next page. A client synced at or above
  `rewriteRevision` fetches with `after`; below it, a delete or a merged history changed rows it
  shows, and it reloads.
- `POST /api/conversations/:conversationKey/messages` with `clientMessageId`, `text` and, for a
  plain chat only, `model: { provider, model, effort }`: answers `{ clientMessageId }` once the
  assistant stored the message, before the reply. The model applies to this turn of the plain
  chat only: the turn runs on its provider, Main on its model and effort, compaction on its model,
  and every other purpose, such as the MCP specialist's, on that provider's saved preference for
  it, else the provider's default. The assistant answers 400 for a plain chat's send without
  `model`, for a provider it does not offer or cannot use now (its API key is missing, its login
  is not connected or expired; the error names the reason), a model that provider does not list
  or an effort the model does not support, and for a `model` sent to the
  Bella conversation, which runs on the account's model settings. A failed turn of a plain chat
  answers the plain failure reply and leaves the account's provider as it is. A turn whose model
  the provider no longer lists when it starts, or whose effort the model no longer supports, runs
  no model, not even another one: it fails with a reply saying so. A repeated send
  with the same id is the same message and is answered the same, for as long as the assistant
  keeps the message's event: 30 days. A client that still holds a pending send after that looks
  for its `clientMessageId` in history before sending again. The reply appears in history.

Live stream, while the app is in the foreground:

- `GET /api/stream`: server-sent events of the signed-in account only, data as JSON. `check`:
  compare revisions now and stop showing typing; `changed`: `conversationKey`, `revision` and
  `rewriteRevision` of a conversation whose transcript changed; `typing`: `conversationKey` and
  `typing`, on when a turn of the conversation is requested and again when it starts running, and
  off when it completes, fails or is dropped, whatever channel its message came from; `deleted`:
  `conversationKey` of a plain chat that is gone. A comment line every 25 seconds keeps an idle
  stream open. After a `changed` the app fetches history. The stream belongs to the session that
  opened it: once that session ends (logout, a new password, expiry) the stream closes at its next
  event or keep-alive. An account holds four streams at most: a fifth ends its oldest.
- The stream opens with `check`, so the app compares revisions for whatever changed while it was
  away. Nothing replays. Within one conversation the events come in the order they happened: a
  `changed` after typing goes off already includes the reply.
- The dashboard holds one stream from the assistant for every account (`GET /internal/stream`,
  lines of JSON with the account id). When it drops, the dashboard sends `check` to every open
  stream, connects again after 2 seconds, and sends `check` again once it is back.

A conversation of another account answers `404 { "error": "Not found" }`, exactly like one that
does not exist, for reading, sending and deleting. The dashboard checks ownership in the
assistant's conversation registry (`findOwnedConversation` in `@bellaclaw/database`); the
assistant checks it again on a send and a delete.

A plain chat is a side conversation of the app: web tools and MCP tools (the profiles that set
`plainChats: true`; `vault` and `logs` stay closed), no memory, reminders, schedules, calendars, automations or settings, and `!` messages
are plain text there. Its persona is the account's setting for all plain chats: Bella's persona,
Bella's persona followed by the chats text, the chats text alone, or none when Bella's persona is
off and the chats text is empty. The Bella conversation always speaks with Bella's persona.

Personality, the same settings as the Personality tab:

- `GET /api/personality`: `{ bellaPersona, plainChatsUseBellaPersona, plainChatsPersona }`.
- `PUT /api/personality` with any of those fields, at least one: changes them and answers the new
  settings. `bellaPersona` must not be blank, and its `{{config.<key>}}` placeholders must name
  settings and still resolve, nested ones included, with the account's settings after the change;
  any other text, `{{commands}}` included, stays as written. A change to any setting that leaves
  them unresolvable is refused. `plainChatsPersona` may be empty. An invalid change answers 400 and changes nothing. Values are
  trimmed.

## Tabs

| Tab | Action |
| --- | --- |
| Model | View and change the AI provider, and the model, effort and service tier per model purpose. |
| Personality | Edit Bella's persona, whether plain chats start from it, and the plain chats' own text. |
| History | Browse the chat's messages, newest first, and delete single messages. |
| Facts | A 3D graph of the facts BellaClaw remembers. Each fact links to its nearest neighbours by embedding similarity. |

An account with no linked chat sees no tabs: a hint to link a chat and the Personality settings.
Unsaved Personality edits stay while the page reloads the same account's tab.

A settings change runs the same checks and provider verification as asking BellaClaw in chat.

## Deleting a Message

The dashboard asks the assistant to delete the message. The assistant publishes
`conversation.message.delete.requested`, and the conversation service answers with
`conversation.message.deleted`.

Deleting a message also removes:

- the tool rows that produced it, when it is an assistant reply
- facts distilled from it

It does not change:

- the compaction summary, which may still describe older conversation
- stored image files

## Security

Exposed:

- The dashboard on `127.0.0.1:8988`, published to the internet only through the reverse proxy.

Not exposed:

- The assistant's internal listener (`BELLACLAW_INTERNAL_API_PORT`, default `3081`). In Compose it
  is only on the Compose network. Outside Compose it binds `127.0.0.1`.
- The log viewer.

The dashboard reads message history, the conversation registry and facts directly from the
assistant's libSQL/Turso database and never writes to it. Every change goes through the internal listener, which has a few fixed
endpoints and requires `Authorization: Bearer BELLACLAW_DASHBOARD_SECRET`.

The secret also signs link tokens. Anyone who has it can create links for any chat and call the
internal listener. Rotating it invalidates unused links.

State:

| Data | Location |
| --- | --- |
| Accounts, password hashes, web and app sessions, chat links, used link tokens | Dashboard SQLite file, `BELLACLAW_DASHBOARD_DB_PATH` |
| Messages, facts, settings | Assistant database |

Web sessions last 30 days from the last request; app sessions last until logout. Only a hash of
each session token is stored. After five failed logins, a username is locked for 15 minutes.
