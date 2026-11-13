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

The assistant publishes no port for the internal listener.

### Reverse Proxy

Bun serves plain HTTP. Terminate TLS in a reverse proxy and forward `443` to `127.0.0.1:8988`.

- The session cookie is `Secure`, so `BELLACLAW_DASHBOARD_PUBLIC_URL` must be HTTPS, or
  `http://localhost` in development.
- Changes are accepted only when the browser's `Origin` matches the public URL. Use the exact
  origin users open.
- Set the proxy's read timeout to at least 255 seconds. A model change waits while the assistant
  verifies the model with the provider, which can take minutes.

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

There is no open sign-up: an account can only be created from a link.

One account can hold many chats. A chat belongs to one account at a time; the latest redeemed link
wins.

There is no password reset. If you forget the password, send `!dashboard` again and create a new
account. The chat moves to it.

## Tabs

| Tab | Action |
| --- | --- |
| Model | View and change the AI provider, and the model, effort and service tier per model purpose. |
| History | Browse the chat's messages, newest first, and delete single messages. |
| Facts | A 3D graph of the facts BellaClaw remembers. Each fact links to its nearest neighbours by embedding similarity. |

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

The dashboard reads message history and facts directly from the assistant's libSQL/Turso database
and never writes to it. Every change goes through the internal listener, which has a few fixed
endpoints and requires `Authorization: Bearer BELLACLAW_DASHBOARD_SECRET`.

The secret also signs link tokens. Anyone who has it can create links for any chat and call the
internal listener. Rotating it invalidates unused links.

State:

| Data | Location |
| --- | --- |
| Accounts, password hashes, sessions, chat links, used link tokens | Dashboard SQLite file, `BELLACLAW_DASHBOARD_DB_PATH` |
| Messages, facts, settings | Assistant database |

Sessions last 30 days from the last request. Only a hash of each session token is stored. After
five failed logins, a username is locked for 15 minutes.
