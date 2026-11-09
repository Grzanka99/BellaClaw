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
| `bun run server:update` | Rebuild without cache and recreate all services. |
| `bun run server:rebuild-embeddings` | Stop the assistant, pull the embedding model, re-embed all facts, and start the assistant on the current image. |
| `bun run server:down` | Stop all services, including the Signal profile. |

## AI Provider Login

After the first start, log in from any activated chat:

```text
!ai-auth login opencode-go
```

Credentials are stored in `.secrets/pi-auth.json` and survive restarts. See
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
