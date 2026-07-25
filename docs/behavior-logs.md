# Behavior Logs

BellaClaw writes structured behavior events to SQLite and standard output. The web viewer reads the
SQLite database without modifying it.

Behavior logs may contain sensitive operational details. Treat the viewer and database as private.

## Standalone Viewer

Run:

```bash
BELLACLAW_LOG_DB_PATH=./bellaclaw-logs.db bun run logs:ui
```

Open:

```text
http://127.0.0.1:8989
```

The viewer provides:

- Full-text search
- Structured filters
- Per-turn timelines
- Optional five-second polling for new matching events

It keeps retrying when the database is missing or unreadable. `GET /health` returns `200` only while
the database can be queried; otherwise it returns `503`.

The standalone viewer binds to `127.0.0.1` by default. Set
`BELLACLAW_LOG_VIEWER_HOSTNAME=0.0.0.0` or a trusted-network address only when you intend to expose
it.

## Compose Viewer

Compose starts the viewer automatically and publishes:

```text
0.0.0.0:8989
```

There is no application login. Restrict access with a host firewall, Tailnet policy, or
authenticated reverse proxy.

The Compose viewer mounts the behavior-log volume read-only.

## Query One Turn

On the host:

```bash
BELLACLAW_LOG_DB_PATH=./bellaclaw-logs.db bun run logs:turn -- <turnId>
```

In the container:

```bash
podman compose exec bellaclaw bun run logs:turn -- <turnId>
```

## Database Path

Defaults:

- Host: `./bellaclaw-logs.db`
- Container: `/app-data/bellaclaw-logs.db`

Override the path with `BELLACLAW_LOG_DB_PATH`.
