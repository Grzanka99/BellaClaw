# Deployment

BellaClaw includes a Podman Compose setup for the assistant, behavior-log viewer, and optional
Signal sidecar.

The repository builds one image. Compose starts the assistant and viewer as separate workspace
commands while mounting the same behavior-log volume.

## First Deployment

On the server:

```bash
cp .env.example .env
```

Fill in the required values from [Configuration](configuration.md), then run:

```bash
podman compose build
bun run server:rebuild-embeddings
```

The services restart unless stopped. The rebuild pulls the embedding model into Ollama and
re-embeds any stored facts before the assistant starts.

This starts:

- `bellaclaw`
- `log-viewer`

The assistant can use the logs MCP profile immediately; Compose configures its connection to
the log viewer without a separate profile file or per-chat sign-in.

Signal uses a Compose profile. See [Messaging](messaging.md#signal).

## Server Scripts

The package scripts include the Signal profile:

| Command | Action |
| --- | --- |
| `bun run server:init` | Build, rebuild embeddings, and start all services. |
| `bun run server:update` | Rebuild without cache, recreate all services, and remove dangling BellaClaw images. |
| `bun run server:rebuild-embeddings` | Stop the assistant, pull the embedding model, re-embed all facts, and start the assistant on the current image. |
| `bun run server:down` | Stop all services, including the Signal profile. |

## Self-Update

The assistant container updates itself from `main` of the checkout's `origin` remote. It needs
only the running containers.

- `!update` in an activated chat checks and updates at once. It needs
  `BELLACLAW_ACTIVATION_TOKEN`.
- `BELLACLAW_AUTO_UPDATE=true` also checks every day at 04:00, container time.

An update downloads the new commit into the `bellaclaw-src` volume, installs its dependencies,
stops the assistant, applies the database migrations, and starts the new code. The assistant is
down for well under a minute. The log viewer follows within 30 seconds. Only the assistant and the log viewer
restart.

Every outcome is sent to all authorized chats:

| Case | Result |
| --- | --- |
| Update installed | Running the new commit. |
| CI of the commit failed | Skipped. A commit with no CI result is installed. |
| Download or install failed | Still running the old commit. |
| Migration failed | Old commit restarted. |
| New commit does not start, no new migration | Rolled back to the old commit. |
| New commit does not start after a migration | No rollback and no notice: the container restarts the new commit until it is fixed. Check `podman logs bellaclaw`. |
| `Containerfile`, `compose.yaml` or the supervisor changed | Held. Run `git pull && bun run server:update` on the server. |

A failed commit is not retried until `main` moves or `!update` is sent. A rollback
keeps the migrated database schema.

A release is a clean copy of `main`: local changes in the server checkout are not carried over.
`bun run server:update` replaces any self-updated release with the checkout's commit.

## AI Provider Login

Set `BELLACLAW_ACTIVATION_TOKEN` before the first start, then activate a chat by sending it the
token (see [Messaging](messaging.md#activation)). Log in from that chat:

```text
!ai-auth login opencode-go
```

Credentials are stored at `BELLACLAW_AI_CREDENTIALS_PATH` (`.secrets/pi-auth.json` in Compose) and
survive restarts. See
[Configuration](configuration.md#ai-and-web) for the other providers and commands.

## Data and Ports

Compose stores:

- Behavior logs in the `bellaclaw-data` volume
- Signal link state in the `signal-cli-data` volume
- AI and Google credentials in the host `.secrets/` directory

Published ports:

| Port | Bind | Purpose |
| --- | --- | --- |
| `8989` | `0.0.0.0` | Behavior-log viewer |
| `8080` | `127.0.0.1` | Signal API, when its profile is active |

The log viewer has no login and may contain sensitive data. Restrict port `8989` with a firewall,
Tailnet policy, or authenticated reverse proxy. See [Behavior Logs](behavior-logs.md).
