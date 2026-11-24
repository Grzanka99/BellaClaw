FROM docker.io/oven/bun:1 AS base

LABEL bellaclaw=1

# NOTE: the updater drives the host's Podman through its socket with these two clients. Debian's
# podman-compose 1.3.0 leaves ${VAR:-default} in a service's environment unresolved, so the
# single-file release is pinned here instead
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git podman-remote python3-dotenv python3-yaml \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/podman-remote /usr/local/bin/podman \
    && python3 -c "import urllib.request; urllib.request.urlretrieve('https://raw.githubusercontent.com/containers/podman-compose/v1.6.0/podman_compose.py', '/usr/local/bin/podman-compose')" \
    && echo "10df1662477a673dc803c03e89c1bc1fba6c8c091e716fb6c7dd09c0081e1255  /usr/local/bin/podman-compose" | sha256sum -c - \
    && chmod +x /usr/local/bin/podman-compose

WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY apps/assistant/package.json apps/assistant/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/log-viewer/package.json apps/log-viewer/package.json
COPY apps/signal-sim/package.json apps/signal-sim/package.json
COPY apps/updater/package.json apps/updater/package.json
COPY packages/behavior-logs/package.json packages/behavior-logs/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile

COPY . .

CMD ["bun", "run", "start"]
