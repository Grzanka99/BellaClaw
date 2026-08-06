# Architecture

BellaClaw owns messaging, persistence, permissions, provider selection, credentials, limits, and
behavior logging. Pi owns model streaming, tool execution, and agent lifecycle events.

## Workspace Boundaries

BellaClaw is a Bun workspace orchestrated by Turborepo:

| Workspace | Ownership |
| --- | --- |
| `@bellaclaw/assistant` | Messaging, AI orchestration, authorization, scheduling, memory, settings, and the Turso/Drizzle database. |
| `@bellaclaw/log-viewer` | Hono routes, query parsing, assets, and behavior-log rendering. |
| `@bellaclaw/behavior-logs` | Behavior event types, SQLite schema, read/write access, and log CLI tools. |
| `@bellaclaw/shared` | Primitives every workspace needs: `TOption`, `AsyncQueue`, the logger, and `REPOSITORY_ROOT`. |

The apps do not import each other. Both depend on the behavior-log package and communicate through
its shared SQLite contract.

Repository-level paths (`.secrets`, hoisted `node_modules`, the default log database) resolve through
`repositoryPath()` from `@bellaclaw/shared`. Workspaces never count `../` segments to the root, so
moving a file cannot silently change which directory it reads.

## Message Flow

1. A Discord or Signal transport receives a direct message.
2. The messaging adapter creates a platform-scoped chat key and behavior trace.
3. The message handler loads settings and the latest 30 stored messages.
4. It classifies the user message's importance and queues it for persistence.
5. A fresh Main agent receives the current message and recent history.
6. Main answers directly or delegates focused work to a specialist.
7. The response is queued for classification and persistence.
8. The transport sends Main's final response.

Discord and Signal use separate chat keys. Their histories and scheduled deliveries do not merge.

## Agent Runtime

Each root run and delegation creates a fresh Pi `Agent`; Pi sessions are not persisted.

Main can use web tools and delegate to:

| Specialist | Responsibility |
| --- | --- |
| Calendar | Read and manage Google Calendar events and calendar access. |
| Memory | Search stored conversation memory. |
| Settings | Read and update per-chat settings. |
| Scheduling | Create, update, list, and remove reminders or recurring tasks. |

Specialists receive only role-specific tools and cannot delegate again. They do not write
conversation memory.

## Scheduled Work

Cron jobs keep the platform-scoped chat key that created them. When a job fires, BellaClaw routes
the result back through that platform.

Scheduled-task agents can read memory, use web tools, and read calendar data. They cannot modify
calendar events, schedules, settings, or memory.

Reminder and scheduled-task output is saved to conversation memory only after successful delivery.
