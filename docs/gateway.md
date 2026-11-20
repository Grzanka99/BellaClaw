# Gateway

The gateway serves the dashboard, a web control panel for the people who chat with BellaClaw, and
the Android app's API. Each user has an account and sees only the chats linked to it. The gateway is meant to be reachable from the internet behind
a TLS reverse proxy.

It lives in the `@bellaclaw/gateway` workspace (`apps/gateway`). The log viewer is a separate
app and stays private; see [Behavior Logs](behavior-logs.md).

## Setup

Set both variables in `.env`; the other gateway variables have defaults (see
[Configuration](configuration.md#gateway)):

```dotenv
BELLACLAW_GATEWAY_PUBLIC_URL=https://dashboard.example.com
BELLACLAW_GATEWAY_SECRET=
```

Generate the secret with:

```bash
openssl rand -base64 32
```

The assistant and the gateway read the same two values. Without either of them, `!dashboard`
replies that the dashboard is not configured, and the gateway process logs one line and exits
with code `0`. Without the secret, the assistant does not start its internal listener.

The gateway also reads `TURSO_CONNECTION_URL` and `TURSO_AUTH_TOKEN` from `.env`.

### Compose

Compose starts the `gateway` service with the other services, so `bun run server:init` and
`bun run server:update` cover it. It:

- publishes `127.0.0.1:8988`, for the reverse proxy on the same host
- reaches the assistant's internal listener at `http://bellaclaw:3081` on the Compose network
- keeps its own database in the `dashboard-data` volume
- restarts only on failure, so an unconfigured gateway stays stopped
- follows a [self-update](deployment.md#self-update) within 30 seconds
- receives only the Turso credentials, the public URL and the secret from `.env`

The assistant publishes no port for the internal listener.

### Reverse Proxy

Bun serves plain HTTP. Terminate TLS in a reverse proxy and forward `443` to `127.0.0.1:8988`.

- The session cookie is `Secure`, so `BELLACLAW_GATEWAY_PUBLIC_URL` must be HTTPS, or
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
2. BellaClaw replies with `BELLACLAW_GATEWAY_PUBLIC_URL/link?token=…`. The link works once and
   expires after 10 minutes.
3. Open it, then create an account or log in. The chat is linked to that account.

An account is created from a link, or in the app with the activation code.

One account can hold many chats. A chat belongs to one account at a time; the latest redeemed link
wins.

If you forget the password, send `!dashboard` again and create a new account. The chat moves to
it.

## The App

The Android app talks only to the gateway and uses the same `/api` routes as the web client.

Its requests carry `Authorization: Bearer <token>`, or, to start a session,
`X-BellaClaw-Client: app`. They never use the cookie and need no `Origin`. Register, login and
link login then answer with the account and `token`, the bearer token of a new app session. An app
session has no idle expiry. `POST /api/logout` with the token ends it, and a new password set
through a login link ends it too.

Device, for notifications:

- Each app session has its own device id, a random value the gateway makes with the session.
  The app never chooses or sees it.
- `PUT /api/device` with `{ fcmToken, publicKey, authSecret }`: registers the session's device for
  the signed-in account and answers `{ ok: true }`. `fcmToken` is its FCM registration token (at
  most 4096 characters); `publicKey` (the P-256 public key, 65 bytes uncompressed, a point on the
  curve) and `authSecret` (16 bytes) are the RFC 8291 key material, base64url. Registering again
  replaces the token and keys, as after a refreshed FCM token. Only an app session has a device;
  the web client gets 403.
- `DELETE /api/device`: unregisters it and answers `{ ok: true }`; 404 when it is not registered.
  The web client gets 403.
- Logout unregisters the session's device before it ends the session; when the assistant cannot
  be reached, logout answers 502 and the session stays, so the app can try again. A new password
  set through a login link first unregisters every device of the account; when the assistant
  cannot, it answers 502 and changes nothing. Once the sessions have ended it removes the
  account's devices again, for one that registered in between.
- While the account has a registered device, the app is its main channel: reminders, scheduled
  task results and notices are stored in the Bella conversation and sent nowhere else. Without
  one they go to the oldest linked chat, and to the app when there is none. A reply always goes
  back to the channel its message came from.

Notifications (when the assistant has an FCM credential, see
[Configuration](configuration.md#push)):

- One push per new message for the app, to every registered device of the account, while the
  account has no app stream open: a reply to a message sent from the app, in the Bella
  conversation or a plain chat (command and failure replies included), and a reminder, scheduled
  task result or notice that went to the app. Never for a reply to a Signal or Discord message, a
  confidential reply (a login link) or the user's own message.
- An FCM data-only message with Android priority `HIGH`. Its only data field, `ciphertext`, is
  the payload encrypted for that one device with RFC 8291 (`aes128gcm`, one record), base64url.
  Nothing else in the message is readable.
- The payload, once decrypted, is UTF-8 JSON (`SAppPush` in `@bellaclaw/shared`):
  `{ conversationKey, kind, messageId, revision, text, truncated }`. `kind` is the conversation's
  kind as the conversation list names it (`bella` or `plain`), so an app started by the push picks
  the notification channel and the chat to open without a fetch. `messageId` is the row's `id` in
  history and `revision` the conversation's revision with it. `text` is the row's text; when the
  whole payload would exceed 2,800 bytes, `text` is its longest start that fits, cut between
  Unicode code points, and `truncated` is `true`. The app then fetches history as on a
  `changed` (with `after`, or a reload below `rewriteRevision`) and finds the rest in row
  `messageId`.
- A failed push is tried four times, 5, 30 and 120 seconds apart, then dropped; the message is
  stored and readable either way. A device whose token FCM reports as unregistered (404
  `UNREGISTERED`) is unregistered at once.

Ways in:

- **Activation code**: `POST /api/register` with `username`, `password` and `activationCode`
  (`BELLACLAW_ACTIVATION_TOKEN`). The assistant checks the code; the gateway never holds it. The
  account has no chat until one is linked. Without a configured code, registration by code answers
  `403`. After five wrong codes, registration by code is closed for everyone for 15 minutes.
- **Password**: `POST /api/login`.
- **`!app`**: BellaClaw replies with `BELLACLAW_GATEWAY_PUBLIC_URL/app?token=…`, which works
  once and expires after 10 minutes. The page offers "Open in app", an Android intent link that
  opens `bellaclaw://login?server=<gateway URL>&token=<token>` in the package
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
  `createdAt` and the app's `clientMessageId`. A user message with images also has `images`, in
  order, each `{ mediaId, mimeType }`: one with a `mediaId` downloads by it; one this conversation
  does not keep, and every image that came through Signal or Discord, is a placeholder without
  one. Its `text` is what the user typed, without the `[Image]` markers the server stores after it
  (one per image), so a message of images only has an empty `text`. Without a cursor, the newest
  50 rows; `before=<id>`
  pages older rows, `nextBefore` names the next older page; `after=<id>` returns the rows after the
  newest one the app has, `nextAfter` names the next page. A client synced at or above
  `rewriteRevision` fetches with `after`; below it, a delete or a merged history changed rows it
  shows, and it reloads.
- `POST /api/conversations/:conversationKey/messages` with `clientMessageId`, `text`, optionally
  `images` (uploads to this conversation, as the upload answered them; `text` may then be empty)
  and, for a plain chat only, `model: { provider, model, effort }`: answers `{ clientMessageId }` once the
  assistant accepted the message, before the reply. The model applies to this turn of the plain
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
  for its `clientMessageId` in history before sending again. The reply appears in history. A
  command whose reply is confidential (`!ai-auth`, `!mcp-auth`) gets no history row for the
  command or the reply: the reply arrives only as the stream's `reply` event. `!app` and
  `!dashboard` sent from the app answer with a plain stored reply. An
  image that was not uploaded by this account to this conversation, or is named with another type,
  answers 400 and nothing is sent.
- `GET /api/models`: every provider a plain chat's `model` may name, in the assistant's order, as
  `{ providers: [{ id, usable, reason?, models: [{ id, name, supportedEfforts }] }] }`. A provider
  that cannot be used now is listed with its models, `usable: false` and `reason`, the error a send
  to it answers. A send's `model` comes from this list: a usable provider, one of its models and
  one of that model's efforts.

Images:

- `POST /api/conversations/:conversationKey/media` with the image's bytes as the body and its type
  as `Content-Type` (`image/jpeg`, `image/png`, `image/webp` or `image/gif`): the gateway streams
  the bytes to the assistant, which checks the type, the size and that the bytes really are that
  format before it stores anything, and answers `{ id, mimeType }` for a send. A file over 5 MB
  answers 413, another type or content 415. Only this route takes a body over 64 KiB.
- `GET /api/conversations/:conversationKey/media/:mediaId`: the image's bytes with its type, for any
  session of the account. An image this conversation does not keep answers
  `410 { "error": "Gone" }`.
- The assistant keeps an image until the cleanup that deletes the files of images older than three
  compactions of the conversation, until its message is deleted, or until its plain chat is
  deleted. An image sent with a command is deleted at once: a command takes none. An image
  uploaded and never sent stays until its plain chat is deleted; in the Bella
  conversation it stays. Images that came through Signal or Discord are never stored, and history
  shows them as placeholders.

Live stream, while the app is in the foreground:

- `GET /api/stream`: server-sent events of the signed-in account only, data as JSON. `check`:
  compare revisions now and stop showing typing; `changed`: `conversationKey`, `revision` and
  `rewriteRevision` of a conversation whose transcript changed; `typing`: `conversationKey` and
  `typing`, on when a turn of the conversation is requested and again when it starts running, and
  off when it completes, fails or is dropped, whatever channel its message came from; `deleted`:
  `conversationKey` of a plain chat that is gone; `reply`: `conversationKey` and `text` of a
  confidential reply (provider sign-in instructions, an MCP sign-in link) to a message sent from
  the app, sent to app sessions' streams only. The app shows a `reply` once in its conversation as a
  message that is not in history: it is never stored or pushed, and is gone after a reload. It
  reaches only a stream open when it is ready; the user asks again for one that was missed. A
  comment line every 25 seconds keeps an idle stream open. After a `changed` the app fetches
  history. The stream belongs to the session that opened it: once that session ends (logout, a
  new password, expiry) the stream closes at its next event or keep-alive. An account holds four
  streams at most: a fifth ends its oldest.
- The stream opens with `check`, so the app compares revisions for whatever changed while it was
  away. Nothing replays. Within one conversation the events come in the order they happened: a
  `changed` after typing goes off already includes the reply.
- The gateway holds one stream from the assistant for every account (`GET /internal/stream`,
  lines of JSON with the account id). When it drops, the gateway sends `check` to every open
  stream, connects again after 2 seconds, and sends `check` again once it is back.
- While that stream is open, the gateway tells the assistant which accounts have an app stream
  open (`POST /internal/presence` with `{ accountIds }`, the whole set): on each connection, and
  when an account's first app stream opens or its last one closes. A failed report is sent again
  after 2 seconds until one succeeds. Only app sessions' streams count; a browser's stream still
  gets every event but `reply`. The assistant keeps it in memory: when the stream drops, or the
  assistant restarts, every account reads closed until the next report.

A conversation of another account answers `404 { "error": "Not found" }`, exactly like one that
does not exist, for reading, sending, deleting, uploading and downloading. The gateway checks ownership in the
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
| History | Browse the Bella conversation's messages, newest first, and delete single messages. |
| Facts | A 3D graph of the facts BellaClaw remembers. Each fact links to its nearest neighbours by embedding similarity. |

An account with no linked chat sees no tabs: a hint to link a chat and the Personality settings.
Unsaved Personality edits stay while the page reloads the same account's tab.

A settings change runs the same checks and provider verification as asking BellaClaw in chat.

## Deleting a Message

The gateway asks the assistant to delete the message. The assistant publishes
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

- The gateway on `127.0.0.1:8988`, published to the internet only through the reverse proxy.

Not exposed:

- The assistant's internal listener (`BELLACLAW_INTERNAL_API_PORT`, default `3081`). In Compose it
  is only on the Compose network. Outside Compose it binds `127.0.0.1`.
- The log viewer.

The gateway reads message history, the conversation registry and facts directly from the
assistant's libSQL/Turso database and never writes to it. Every change goes through the internal listener, which has a few fixed
endpoints and requires `Authorization: Bearer BELLACLAW_GATEWAY_SECRET`.

The secret also signs link tokens. Anyone who has it can create links for any chat and call the
internal listener. Rotating it invalidates unused links.

State:

| Data | Location |
| --- | --- |
| Accounts, password hashes, web and app sessions (with each app session's device id), chat links, used link tokens | Gateway SQLite file, `BELLACLAW_GATEWAY_DB_PATH` |
| Messages, facts, settings | Assistant database |
| App devices: FCM token and RFC 8291 key material | Assistant database, `app_devices` |
| FCM service-account key | Assistant only, `BELLACLAW_FCM_CREDENTIALS_PATH` |
| Images uploaded from the app | Assistant's data volume, `BELLACLAW_APP_MEDIA_DIR`, listed in the assistant database |

Web sessions last 30 days from the last request; app sessions last until logout. Only a hash of
each session token is stored. After five failed logins, a username is locked for 15 minutes.
