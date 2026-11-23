# Connectors

A connector is an external tool server BellaClaw reaches through one generic specialist: an MCP
server, or a UTCP server added through the assistant (see [UTCP connectors](#utcp-connectors)).
`connectors.json` holds MCP servers only. Both conversation and scheduled-task agents can delegate to a
connector. Adding a server requires configuration, not a new agent or tool implementation.

## Configure connectors

The repository includes `connectors.json` with the logs and vault connectors enabled. Logs needs no OAuth connection:
Main and ScheduledTask can use it as soon as the log viewer is running. `bun run dev` uses the
local viewer at `127.0.0.1:8989`; Compose supplies `http://log-viewer:8989/mcp` automatically.
MCP connections open when needed rather than occupying a permanent session for each chat.

To add your own connectors, copy the default file to `connectors.local.json`, edit it, and set
`BELLACLAW_CONNECTORS_CONFIG=./connectors.local.json`; relative paths are resolved from the
repository root. In Compose, mount `./connectors.local.json:/app/connectors.local.json:ro` into
the assistant and set `BELLACLAW_CONNECTORS_CONFIG=/app/connectors.local.json`: a self-updated
release resolves a relative path from its own directory. Local connector files are excluded from
Git and container builds. An absent selected file disables connectors.
A server set up before connectors were renamed keeps working: when `BELLACLAW_CONNECTORS_CONFIG`
is not set, `BELLACLAW_MCP_CONFIG` names the file if that file exists, and a file may still list
its connectors under the old `profiles` key.
Configuration is read for each new delegation; an existing specialist keeps its current connector
and connection until it finishes.

The file's top-level `connectors` array lists the connectors. Each connector contains:

| Field | Meaning |
| --- | --- |
| `id` | Stable connector identifier, such as `logs` |
| `description` | Brief routing description shown to Main and ScheduledTask |
| `instructions` | Instructions supplied only to that connector's specialist |
| `transport` | `{ "type": "http", "url": "…", "headers": {} }` or `{ "type": "stdio", "command": "…", "args": [], "env": {} }` |
| `tools` | Optional explicit list of server tool names; omitted means all discovered tools |
| `resources`, `prompts`, `sampling` | Capability switches, each enabled by default |
| `plainChats` | Whether the app's plain chats may use the connector; closed by default. Set it to true to let the app's plain chats use the connector. `vault` (personal notes) and `logs` (owner diagnostics) stay closed, so a plain chat has connector tools only once a connector sets it to true |
| `contextArguments` | Map server tool argument names to `ownerKey` (the owner of settings, facts and credentials), `conversationKey` (the conversation the specialist serves) or `turnId`; supplied by the runtime and hidden from the model's argument schema |
| `requestTimeoutMs` | Request timeout allowance, default 120000 |
| `inputTimeoutMs` | User-input wait allowance, default 900000 |

HTTP URLs can use `${ENV_NAME:-fallback}` to select an endpoint at runtime. Set
`"tokenAuth": true` on an HTTP transport when each chat supplies its own bearer token (see
[Per-chat tokens](#per-chat-tokens)); it cannot be combined with `oauth`.

The stdio command is executed directly with an argument array. Its process receives the SDK's
minimal default environment plus the connector's `env` values. HTTP headers are operator supplied.
An authenticated specialist's connection belongs to its chat and invocation. It stays alive
across questions to the user and closes when that invocation completes or is cancelled.

## Connectors added through the assistant

Besides the server-wide, operator-managed `connectors.json`, each user (an account, or an
unlinked chat) can add their own MCP or UTCP servers by asking the assistant: “connect my notes server at https://notes.example.com/mcp”.
The assistant checks once that the URL answers as an MCP (or UTCP) server, then asks to add it. The new
connector stays pending and unusable until you approve it; asking to remove one leaves it in use,
pending removal, until you approve that too. You approve with a chat command you send
yourself:

```text
!connector list
!connector approve CONNECTOR
!connector reject CONNECTOR
```

`list` shows each of your added connectors with its kind (`mcp` or `utcp`), status, whether plain
chats may use it, its URL and description, written by the command
itself rather than the model, so check it before approving. `approve` makes a pending add
active or completes a pending removal; `reject` drops a pending add or keeps a connector that was
pending removal.

If an MCP server asks for credentials, give them after approval with `!connector-auth`, choosing by
the command you send: `!connector-auth token CONNECTOR TOKEN` sends that bearer token, and
`!connector-auth connect CONNECTOR` signs in with OAuth through the server's client registration
(this needs `BELLACLAW_MCP_PUBLIC_URL`, see [Per-chat OAuth](#per-chat-oauth)). `status` and
`disconnect` work as for other connectors. Send a token only in this command, never in a
message to the assistant. Approving a removal also deletes your saved credentials for it.

Added connectors belong to you alone. They use HTTP or HTTPS only and always offer all of the
server's tools that BellaClaw can run. They are closed to the app's plain chats unless you ask the
assistant to switch that on. An added MCP connector's specialist uses the server's own instructions in place of operator-written ones. An
id that `connectors.json` already uses cannot be added.

## UTCP connectors

A [UTCP](https://www.utcp.io) server publishes a manual: a JSON list of tools, each with a call
template saying how to call it over HTTP. Add one by asking the assistant and naming UTCP: “add
the UTCP weather server at https://weather.example.com/utcp”. When you name no protocol, the
assistant tries MCP first and UTCP if that cannot connect. Approval works as for any added
connector, and `!connector list` shows it as `utcp`. The UTCP SDK sends requests only over
HTTPS, or HTTP to `localhost`, `127.0.0.1` or `[::1]`, so the manual's URL must be one of those.

The SDK fetches the manual again each time the connector is used, so its tools, descriptions and
schemas are always the server's current ones. The URL may also point to an OpenAPI (or Swagger)
document, which the SDK converts into a manual. The converter skips an operation without an
`operationId`, and a document whose `servers` URL is relative registers its tools, but their calls
are refused because the URL is not https. Each tool result is limited to 1 MiB; a streamed
(SSE or streamable HTTP) result is read in full before the limit is applied.

- Tools use the call templates of the SDK's HTTP plugin: HTTP, SSE and streamable HTTP. CLI,
  Text/File and UTCP-over-MCP call templates are not supported and may be added later; the SDK
  rejects a manual with such a tool, and the connector cannot be added or opened.
- `!connector-auth` does not apply to UTCP connectors. A server that answers the manual request
  with an error, including one that asks for credentials, cannot be reached and is not added.
- A call template may name variables (`${NAME}` or `$NAME`), such as an API key in a header. The SDK
  reads a variable from the assistant's environment. The environment variable it reads is the
  connector's id with each `-` written as `__`, then `_` and the variable's name: `API_KEY` of
  connector `weather` is `weather_API_KEY`, and of connector `my-notes` it is `my__notes_API_KEY`.
  A variable that is not set makes the request that names it fail.

UTCP uses the pinned official TypeScript SDK (`@utcp/sdk`, `@utcp/http`). It has no prompts,
resources, sampling or elicitation, so `!mcp-prompts` answers "This connector does not expose prompt templates."

## Supported capabilities

For MCP connectors:


- Stdio and Streamable HTTP, using the pinned official TypeScript MCP SDK.
- Paginated tool discovery, runtime JSON Schemas, typed Pi tool calls, tool-list changes,
  structured results, server errors, cancellation, and bounded output.
- Resource discovery, URI templates, reads, subscriptions and session-local update notifications.
- Prompt discovery and rendering, plus argument completion when the server supports it.
- Sampling, including server-supplied tools, through the configured specialist model.
- Form and URL elicitation, routed through the conversation instead of blocking the chat queue.

MCP text and images become model tool content. Other blocks remain in result details and receive
an explicit textual description when Pi cannot render them, such as audio or binary blobs.
Results larger than 1 MiB are rejected with instructions to narrow the query. This is the supported
capability set rather than a promise to implement every optional or experimental MCP extension.

## Conversation, prompts and scheduled tasks

Ask normally: “Any failures recently?” or “Why did my last call take so long?” Main chooses a
connector and provides the specialist with the task and relevant context. The specialist's
intermediate transcript remains separate from Main's conversation.

Commands use the existing `!` prefix:

```text
!mcp-prompts
!mcp-prompts logs
!mcp-prompt logs diagnose-turn {"turnId":"message:…","chatId":"discord:…"}
!connector-auth connect CONNECTOR
!connector-auth token CONNECTOR TOKEN
!connector-auth status CONNECTOR
!connector-auth disconnect CONNECTOR
!connector list
!connector approve CONNECTOR
!connector reject CONNECTOR
```

Prompt execution enters the normal message pipeline. Natural-language requests to use a named
template work too. Scheduled tasks can name a connector and template in their task instructions.
Resources may be read as needed; server prompt templates are used when explicitly requested.

When a server needs input, the live specialist yields a `needs_input` result. Main asks the user.
The next turn can resume the retained specialist with the reply, or decline or cancel the request.
Scheduled requests are associated with the originating chat so a conversational reply can resume
them. Waiting does not occupy the per-chat message queue. Paused runs are in memory only; there
is no restart recovery or automatic replay of completed operations.

## Per-chat OAuth

For an HTTP connector requiring OAuth, add `transport.oauth`. Use environment-variable names for
pre-registered client credentials, or omit them when the server supports client registration:

```json
{
  "oauth": {
    "clientIdEnv": "EXAMPLE_MCP_CLIENT_ID",
    "clientSecretEnv": "EXAMPLE_MCP_CLIENT_SECRET",
    "scopes": ["documents.read"],
    "authorizationParams": { "audience": "https://mcp.example.com" }
  }
}
```

Set the referenced credential variables in `.env`. Set `BELLACLAW_MCP_PUBLIC_URL` to the
externally reachable HTTPS origin. Setting it starts the assistant's callback listener on
`BELLACLAW_MCP_AUTH_PORT` (default 3080). Configure your reverse proxy to forward
`/mcp/oauth/callback` to this listener, and register that exact callback URL with the OAuth
provider. Compose publishes the listener on host loopback port 3080.

Each chat runs `!connector-auth connect CONNECTOR`, opens the returned sign-in link, and completes the
provider's consent flow. The callback binds credentials to that chat. Discord and Signal chats
are independent even when operated by the same person. Tokens are stored atomically in
`.secrets/mcp-credentials.json` (override with `BELLACLAW_MCP_CREDENTIALS_PATH`). Refresh exchanges
are coordinated when scheduled and conversational work overlap. Disconnect closes that chat's
live connections for the connector.

OAuth belongs to the HTTP MCP connection. A server may separately use URL elicitation for its
own upstream-account onboarding. The assistant shows that URL to the user; it does not collect
those credentials in chat.

## Per-chat tokens

For an HTTP connector with `"tokenAuth": true`, each chat runs `!connector-auth token CONNECTOR TOKEN`.
The token is sent as `Authorization: Bearer TOKEN` on that chat's connections only. It is stored
with the OAuth credentials and bound to the connector URL, so changing the URL requires a new token.
Saving a new token closes the chat's live connections for the connector. `status` and `disconnect`
work as for OAuth. Commands are answered directly: the token never reaches the model, the
conversation history or the behavior logs. It does stay in the chat platform's message history,
so prefer a direct message and a token you can revoke.

## Obsidian vault

The `vault` connector connects to an [mcp-vault](https://github.com/Grzanka99/vault-sync-and-mcp)
server, which syncs an Obsidian vault and exposes it over MCP. The connector uses
`BELLACLAW_VAULT_MCP_URL` when set, otherwise `http://127.0.0.1:8787/mcp`. `.env.example` sets the
Compose address `http://host.containers.internal:8787/mcp`; clear it for `bun run dev`.

Create a token on the vault server and give it to the chat:

```sh
pnpm server token create USERNAME bellaclaw
```

```text
!connector-auth token vault mv_…
```

On the same machine, the contents of the server's `data/local-agent.token` also work. Revoke
a token with `pnpm server token revoke ID`.

## Logs server

The existing log viewer exposes Streamable HTTP at `/mcp`. The default logs connector uses
`BELLACLAW_LOGS_MCP_URL` when set, otherwise `http://127.0.0.1:8989/mcp`; Compose sets the
variable to `http://log-viewer:8989/mcp`.
The logs MCP endpoint has the same general availability as the viewer, without another login.
If you set `LOG_CHATID_HMAC_KEY`, use the same value in both applications so chat-scoped queries
can match the masked log IDs. Compose forwards it to the viewer.

The server reuses the read-only `@bellaclaw/behavior-logs` reader. Its operations are:

- `recent_failures`: failed operations or error-level events, default last hour.
- `latest_turn_latency`: the latest completed conversational turn and its event timeline.
- `cache_hit_rate`: the previous ten completed user turns for the current chat, including
  specialist model calls. It reports totals and usage coverage. The rate is
  `100 × sum(cacheRead) / sum(inputTokens)`, not an average of percentages.
- `logs://schema`, `logs://turn/{turnId}`, and the `diagnose-turn` prompt.

The default connector injects `chatId` and `excludeTurnId` into tools. This is a query convenience,
not an additional access restriction. Current diagnostic work is excluded from its own results.
Overlapping model, tool and delegation durations must not be added together. Provider-internal
latency cannot be explained beyond what the recorded spans measure.

## Verification

Transport tests launch real local stdio and HTTP servers. Scripted model tests check delegation,
sampling and continuation. OAuth tests use a local authorization server, and logs tests use
temporary SQLite files. CI requires neither external credentials nor paid model requests.
