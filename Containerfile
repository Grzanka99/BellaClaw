FROM docker.io/oven/bun:1 AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY apps/assistant/package.json apps/assistant/package.json
COPY apps/log-viewer/package.json apps/log-viewer/package.json
COPY packages/behavior-logs/package.json packages/behavior-logs/package.json
RUN bun install --frozen-lockfile

COPY . .

CMD ["bun", "run", "start"]
