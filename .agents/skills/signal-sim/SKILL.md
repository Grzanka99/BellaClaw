---
name: signal-sim
description: Talk to a running BellaClaw assistant from the shell through a fake Signal server. Use to test assistant behaviour empirically (real model, real MCP, throwaway database and vault), to reproduce a conversation bug, or to check a change end to end.
---

# signal-sim

`apps/signal-sim` is a fake `signal-cli-rest-api`. The real assistant connects to it as its Signal
account, and you speak to the assistant as any phone number with `bun run sim`. Models, MCP and
embeddings are real; the database, notes vault and behavior logs are throwaway.

`bun run sim` with no arguments prints every command. Each takes `--json`.

## 1. Start the stack

Run `bun run dev:sim` in the background and keep its output in a file. It starts three containers
(libSQL, mcp-vault, Ollama), migrates the database, then runs the sim, the log viewer and the
assistant with file watching. Ready when the output contains `Signal receive subscription active`
and `bun run sim status` says `assistant connected`.

If the vault image fails to build, set `SIGNAL_SIM_VAULT_CONTEXT` to a local checkout of
`vault-sync-and-mcp`.

State lives in `~/.config/bellaclaw-sim` and is shared by every worktree, so one stack runs at a
time. If `dev:sim` reports the port is taken, another session owns the stack: use it as it is.

## 2. Prepare a chat

Each phone number is its own chat and needs these once. `--from` defaults to `+15550000001`.

1. Activate: `bun run sim send --wait sim-activation-token`. Done when the reply is `Activated.`
   A number that has not activated gets silence.
2. Model login, once per machine: send any message. If the reply says the provider is not
   connected, send `!ai-auth login opencode-go` (or `openai-codex`), give the returned link and code
   to the user, and wait for them to finish. Done when a normal message gets a model reply.
3. Vault, only when the test touches notes:
   `bun run sim send --wait "!mcp-auth token vault $(bun run --silent sim vault-token)"`.

## 3. Converse

- `bun run sim send --wait [--from N] TEXT` sends and prints the assistant's whole turn. The turn
  ends when the assistant stops typing, so several replies come back together.
- `bun run sim wait --timeout 300` blocks for a message the assistant sends on its own, such as a
  reminder. Scheduled things run on the real clock: ask for "in 2 minutes" and wait.
- `--image PATH` and `--audio PATH` attach files in the real Signal format.
- Use a second `--from` number to test that chats stay separate.

Exit code 1 from `wait` means no reply arrived in time: read the stack output before retrying.

## 4. Inspect

- `bun run sim log --events` shows the wire transcript with typing and read receipts.
- The stack output holds the assistant's logs; the log viewer at `http://127.0.0.1:8989` holds
  per-turn behavior logs, also reachable by asking the assistant about its last turn.
- `group`, `duplicate`, `disconnect` and `noise` inject what real Signal produces besides plain
  messages. Their effect shows only in `log --events` and the assistant's logs.
- The event log lives in the sim database (libSQL HTTP API, port 18081). Query it with:

```bash
simsql() {
  curl -s http://127.0.0.1:18081/v2/pipeline -H 'content-type: application/json' \
    -d "{\"requests\":[{\"type\":\"execute\",\"stmt\":{\"sql\":\"$1\"}},{\"type\":\"close\"}]}"
}
simsql "select e.type, d.consumer, d.status from events e left join event_deliveries d on d.eventSeq = e.seq order by e.seq desc limit 20"
```

## 5. Hand over the transcript

Every test ends with the whole conversation in a throwaway file the user can read:
`tmp/sim-transcript-<YYYYMMDD-HHMM>.md` (`tmp/` is git-ignored). One heading per number from
`bun run sim chats`, and under it that number's `bun run --silent sim log --from N --limit 1000`
output from your first message of this test onward, in a code block. Done when every number you
used is in the file and you have given the user its path.

## 6. Stop

Stop `dev:sim`, then `bun run sim down`. `bun run sim reset` also wipes the database, vault,
transcript and vault token, and keeps the model login. Reset when a test needs a clean history or a
fresh run of every migration.

Calendar and Discord are off in the sim.
