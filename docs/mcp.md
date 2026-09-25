# MCP integrations

BellaClaw connects to configured MCP servers through one generic specialist. Both conversation
and scheduled-task agents can delegate to a profile. Adding a server requires configuration,
not a new agent or tool implementation.

## Configure profiles

The repository includes `mcp.json` with the logs profile enabled. It needs no OAuth connection:
Main and ScheduledTask can use it as soon as the log viewer is running. `bun run dev` uses the
local viewer at `127.0.0.1:8989`; Compose supplies `http://log-viewer:8989/mcp` automatically.
MCP connections open when needed rather than occupying a permanent session for each chat.

To add your own profiles, copy the default file to `mcp.local.json`, edit it, and set
`BELLACLAW_MCP_CONFIG=./mcp.local.json`; relative paths are resolved from the repository root.
In Compose, mount `./mcp.local.json:/app/mcp.local.json:ro` into the assistant. Local profile
files are excluded from Git and container builds. An absent selected file disables MCP.
Configuration is read for each new delegation; an existing specialist keeps its current profile
and connection until it finishes.

Each profile contains:

| Field | Meaning |
| --- | --- |
| `id` | Stable profile identifier, such as `logs` |
| `description` | Brief routing description shown to Main and ScheduledTask |
| `instructions` | Instructions supplied only to that profile's specialist |
| `transport` | `{ "type": "http", "url": "…", "headers": {} }` or `{ "type": "stdio", "command": "…", "args": [], "env": {} }` |
| `tools` | Optional explicit list of server tool names; omitted means all discovered tools |
| `resources`, `prompts`, `sampling` | Capability switches, each enabled by default |
| `contextArguments` | Map server tool argument names to `chatId` or `turnId`; supplied by the runtime and hidden from the model's argument schema |
| `requestTimeoutMs` | Request timeout allowance, default 120000 |
| `inputTimeoutMs` | User-input wait allowance, default 900000 |

HTTP URLs can use `${ENV_NAME:-fallback}` to select an endpoint at runtime.

The stdio command is executed directly with an argument array. Its process receives the SDK's
minimal default environment plus the profile's `env` values. HTTP headers are operator supplied.
An authenticated specialist's connection belongs to its chat and invocation. It stays alive
across questions to the user and closes when that invocation completes or is cancelled.

## Supported capabilities

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
profile and provides the specialist with the task and relevant context. The specialist's
intermediate transcript remains separate from Main's conversation.

Commands use the existing `!` prefix:

```text
!mcp-prompts
!mcp-prompts logs
!mcp-prompt logs diagnose-turn {"turnId":"message:…","chatId":"discord:…"}
!mcp-auth connect PROFILE
!mcp-auth status PROFILE
!mcp-auth disconnect PROFILE
```

Prompt execution enters the normal message pipeline. Natural-language requests to use a named
template work too. Scheduled tasks can name a profile and template in their task instructions.
Resources may be read as needed; server prompt templates are used when explicitly requested.

When a server needs input, the live specialist yields a `needs_input` result. Main asks the user.
The next turn can resume the retained specialist with the reply, or decline or cancel the request.
Scheduled requests are associated with the originating chat so a conversational reply can resume
them. Waiting does not occupy the per-chat message queue. Paused runs are in memory only; there
is no restart recovery or automatic replay of completed operations.

## Per-chat OAuth

For an HTTP profile requiring OAuth, add `transport.oauth`. Use environment-variable names for
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

Each chat runs `!mcp-auth connect PROFILE`, opens the returned sign-in link, and completes the
provider's consent flow. The callback binds credentials to that chat. Discord and Signal chats
are independent even when operated by the same person. Tokens are stored atomically in
`.secrets/mcp-credentials.json` (override with `BELLACLAW_MCP_CREDENTIALS_PATH`). Refresh exchanges
are coordinated when scheduled and conversational work overlap. Disconnect closes that chat's
live connections for the profile.

OAuth belongs to the HTTP MCP connection. A server may separately use URL elicitation for its
own upstream-account onboarding. The assistant shows that URL to the user; it does not collect
those credentials in chat.

## Logs server

The existing log viewer exposes Streamable HTTP at `/mcp`. The default logs profile uses
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

The default profile injects `chatId` and `excludeTurnId` into tools. This is a query convenience,
not an additional access restriction. Current diagnostic work is excluded from its own results.
Overlapping model, tool and delegation durations must not be added together. Provider-internal
latency cannot be explained beyond what the recorded spans measure.

## Verification

Transport tests launch real local stdio and HTTP servers. Scripted model tests check delegation,
sampling and continuation. OAuth tests use a local authorization server, and logs tests use
temporary SQLite files. CI requires neither external credentials nor paid model requests.
