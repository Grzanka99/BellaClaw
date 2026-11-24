# Deployment

BellaClaw includes a Podman Compose setup for the assistant, behavior-log viewer, gateway, updater,
and optional Signal sidecar.

The repository builds one image. Compose starts the assistant, viewer and gateway as separate
workspace commands. The assistant and viewer mount the same behavior-log volume.

## First Deployment

Run every command on the server, as the user that runs the containers, from the checkout root. The
first two give the updater its Podman socket (see [Requirements](#requirements)):

```bash
systemctl --user enable --now podman.socket
sudo loginctl enable-linger "$USER"
cp .env.example .env
```

Fill in the required values from [Configuration](configuration.md), then run:

```bash
podman compose build
bun run server:rebuild-embeddings
podman compose up -d
```

The services restart unless stopped. The rebuild pulls the embedding model into Ollama and
re-embeds any stored facts before the assistant starts.

This starts:

- `bellaclaw`
- `log-viewer`
- `gateway`, which exits when it is not configured (see [Gateway](gateway.md))
- `bellaclaw-updater` (see [Self-Update](#self-update))

The assistant can use the logs connector immediately; Compose configures its connection to
the log viewer without a separate connectors file or per-chat sign-in.

Signal uses a Compose profile. See [Messaging](messaging.md#signal).

## Server Scripts

The package scripts include the Signal profile:

| Command | Action |
| --- | --- |
| `bun run server:init` | Build, rebuild embeddings, and start all services. |
| `bun run server:update` | Rebuild the checkout's commit without cache, recreate all services including the updater, and remove dangling BellaClaw images. The assistant applies pending database migrations when it starts. |
| `bun run server:migrate-to-gateway` | Once, on a server whose `.env` still has `BELLACLAW_DASHBOARD_*` settings: rename them to `BELLACLAW_GATEWAY_*`, remove the old `bellaclaw-dashboard` container (its data volume stays), then run `server:update`. Run it while the assistant is idle (see below). |
| `bun run server:rebuild-embeddings` | Stop the assistant, pull the embedding model, re-embed all facts, and start the assistant on the current image. |
| `bun run server:down` | Stop all services, including the Signal profile. |

Before `server:migrate-to-gateway`, let the assistant go idle. The move changes the payloads of
most events, so one of those still waiting from before it, such as a reply retried while Signal
is unreachable, cannot be read afterwards: its delivery ends dead and the event is never handled.

If the gateway then logs that the link of a chat is stuck, list the dead deliveries, redrive the
`identity.link.started`, `.settled`, `.quiet` and `.moved` ones by their `<eventSeq>:<consumer>`,
and restart the assistant:

```bash
podman compose exec bellaclaw bun run --cwd apps/assistant events:redrive
podman compose exec bellaclaw bun run --cwd apps/assistant events:redrive -- <eventSeq>:<consumer> ...
podman compose restart bellaclaw
```

## Self-Update

The `bellaclaw-updater` container updates the deployment from `main` of the checkout's `origin`
remote. It holds the Podman socket of the user that runs the containers and mounts the repository
checkout at its host path. The assistant container gets neither.

- `!update` in an activated chat checks and updates at once. It needs
  `BELLACLAW_ACTIVATION_TOKEN`.
- `BELLACLAW_AUTO_UPDATE=true` also checks every day at 04:00, container time.

### Requirements

Once per server, as the user that runs the containers:

```bash
systemctl --user enable --now podman.socket
sudo loginctl enable-linger "$USER"
```

Lingering keeps the socket without a login session. Access to the socket equals that user's
access to Podman.

Run Compose as that user from the checkout root: `compose.yaml` mounts `${PWD}` and
`${XDG_RUNTIME_DIR}/podman/podman.sock` into the updater.

The updater has no SSH key: a `git@github.com:` remote is read over HTTPS.

### How an Update Runs

1. Read `main` of `origin`. Nothing happens when the checkout is already on it.
2. Check the commit's CI on GitHub. Failed: skipped. Pending, or GitHub did not answer: checked
   again every 10 minutes. No CI on the commit: installed.
3. Fast-forward the server checkout to the commit.
4. Tag the running image `bellaclaw:previous` and build `bellaclaw:local` with `--pull` and the
   layer cache. If the image does not hold the new commit, build once more without cache.
5. Start the one-off container `bellaclaw-update-runner` from the new image. The runner stops the
   assistant, runs pending update scripts, applies database migrations when the commit has new
   ones, recreates the containers, and waits up to 120 seconds for the assistant to report ready.
   It then reports, removes dangling BellaClaw images, and replaces the updater.

The image is always rebuilt, so changes to `Containerfile`, `compose.yaml` and the updater install
like any other code.

| `compose.yaml` | Recreated | Kept running |
| --- | --- | --- |
| Unchanged | Assistant, log viewer, gateway, then the updater | Ollama, Signal sidecar |
| Changed | Every container of the project, the Signal profile included | — |

Deployment changes a migration cannot make, such as renaming a key in `.env`, are update scripts
in `apps/updater/updates/`. Each runs once per server. See
[Update Scripts](../apps/updater/updates/README.md).

### Server Checkout

The updater moves the server checkout, so it always holds the running commit. Tracked files edited
by hand hold the update; the chat is told which files. Untracked files, such as `.env` and
`.secrets/`, are left alone.

### Status and Outcomes

Status lines go only to the chat that sent `!update`: the commits being installed, the build time,
each update script, and the outcome with the downtime. In the app they are the steps of the
command's card, which ends on the outcome. A scheduled update reports to no chat. The
outcome of an installed update is in `podman logs bellaclaw-update-runner`, which stays until the
next update. `podman logs bellaclaw-updater` holds the checks and anything that stopped before the
runner started; it starts empty after each installed update, because the updater is replaced.

| Case | Result |
| --- | --- |
| Update installed | Running the new commit. |
| CI of the commit failed | Skipped. |
| Checkout edited by hand, no fast-forward, or build failed | Still running the old commit. Nothing was stopped. |
| Update script or migration failed | Old commit restarted, and the error is sent. A script that changed something before it failed may leave the old version unable to start. |
| New commit not ready within 120 seconds, no migration | Rolled back to the previous image and commit. |
| New commit not ready after a migration | No rollback: the old code cannot use the new schema. The container restarts the new commit, and the updater checks `main` every 10 minutes and installs a fix pushed there. The notice arrives once an assistant runs again. |
| Runner crashed | The updater, still on the old code, restores the old version. After a migration it starts the new one without a rollback instead. |

A failed commit is not retried until `main` moves or `!update` is sent.

These still need a login on the server:

- a new secret in `.env`
- a checkout edited by hand
- an update script that left things half-changed
- a broken updater

To update by hand, run `git pull && bun run server:update` on the server. The assistant applies
pending database migrations when it starts. A manual update runs no update scripts: pending ones
run with the next self-update.

### Moving from the Old Self-Updater

A deployment whose containers still run `apps/assistant/scripts/supervisor.ts` cannot install the
updater by itself. Once, on the server, meet the [requirements](#requirements), then run:

```bash
git pull && bun run server:update
```

The old `bellaclaw-src` volume is then unused. Find its full name with `podman volume ls` and
remove it with `podman volume rm`.

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

- Behavior logs and the updater's state in the `bellaclaw-data` volume
- Signal link state in the `signal-cli-data` volume
- Gateway accounts and sessions in the `dashboard-data` volume
- AI and Google credentials in the host `.secrets/` directory

Published ports:

| Port | Bind | Purpose |
| --- | --- | --- |
| `8989` | `0.0.0.0` | Behavior-log viewer |
| `8988` | `127.0.0.1` | Gateway, for the reverse proxy |
| `8080` | `127.0.0.1` | Signal API, when its profile is active |

The log viewer has no login and may contain sensitive data. Restrict port `8989` with a firewall,
Tailnet policy, or authenticated reverse proxy. See [Behavior Logs](behavior-logs.md).

The gateway is meant for the internet behind a TLS reverse proxy. The assistant's internal
listener on `3081` stays on the Compose network and is not published. See
[Gateway](gateway.md#reverse-proxy).
