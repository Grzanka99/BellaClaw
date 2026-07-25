# Deployment

BellaClaw includes a Podman Compose setup for the assistant, behavior-log viewer, and optional
Signal sidecar.

## First Deployment

On the server:

```bash
cp .env.example .env
```

Fill in the required values from [Configuration](configuration.md), then run:

```bash
podman compose up -d --build
```

The services restart unless stopped.

This command starts:

- `bellaclaw`
- `log-viewer`

Signal uses a Compose profile. See [Messaging](messaging.md#signal).

## Server Scripts

The package scripts include the Signal profile:

| Command | Action |
| --- | --- |
| `bun run server:init` | Seed optional Codex auth, build, and start all services. |
| `bun run server:update` | Preserve auth, rebuild without cache, and recreate all services. |
| `bun run server:down` | Stop all services, including the Signal profile. |
| `bun run server:reset-auth` | Replace Pi credentials from `.secrets/auth.json`. |

## OpenAI Codex Subscription

Create the secrets directory:

```bash
mkdir -p .secrets
```

Copy an authenticated Codex `auth.json` to:

```text
.secrets/auth.json
```

Seed it and start the services:

```bash
bun run server:init
```

The seed script creates `.secrets/pi-auth.json` when it does not exist. Later starts preserve that
file so Pi can refresh and store OAuth tokens.

To intentionally replace it:

```bash
bun run server:reset-auth
```

Seeding credentials does not change the active provider. After startup, ask BellaClaw to switch to
`openai-codex`.

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
