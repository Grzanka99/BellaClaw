import { z } from "zod";

// one "!" command as the app lists it. name: without "!"; usage: forms joined by " | ", fixed
// choices joined by "|", placeholders in capitals, optional ones in []
export const SCommandEntry = z
  .object({
    name: z.string(),
    group: z.string(),
    description: z.string(),
    usage: z.string(),
  })
  .strict();

export type TCommandEntry = z.infer<typeof SCommandEntry>;

// every command, in the app's palette order; groups in order Connectors, Calendar, AI, App
export const COMMAND_CATALOG = {
  connector: {
    name: "connector",
    group: "Connectors",
    description: "List your added connectors, or approve or reject a pending add or removal.",
    usage: "!connector list | !connector approve|reject CONNECTOR",
  },
  "connector-auth": {
    name: "connector-auth",
    group: "Connectors",
    description:
      "Connect, disconnect, or check authentication for an OAuth or token connector in this chat.",
    usage:
      "!connector-auth connect|disconnect|status CONNECTOR | !connector-auth token CONNECTOR TOKEN",
  },
  "mcp-prompts": {
    name: "mcp-prompts",
    group: "Connectors",
    description: "List connectors, or list a connector's prompt templates",
    usage: "!mcp-prompts [CONNECTOR]",
  },
  "mcp-prompt": {
    name: "mcp-prompt",
    group: "Connectors",
    description: "Ask the assistant to run an MCP prompt template",
    usage: "!mcp-prompt CONNECTOR PROMPT [JSON_ARGUMENTS]",
  },
  "calendar_add-write": {
    name: "calendar_add-write",
    group: "Calendar",
    description:
      "Set the Google calendar the bot writes events to. The calendar must already be shared with the bot's service account with write access. Sending it again replaces the current one.",
    usage: "!calendar_add-write CALENDAR_ID",
  },
  "calendar_add-read": {
    name: "calendar_add-read",
    group: "Calendar",
    description:
      "Add a Google calendar the bot reads events from. The calendar must already be shared with the bot's service account. It is always stored read-only.",
    usage: "!calendar_add-read CALENDAR_ID",
  },
  "ai-auth": {
    name: "ai-auth",
    group: "AI",
    description: "Log in to, check, or log out of an AI provider subscription.",
    usage: "!ai-auth login|status|logout PROVIDER",
  },
  stop: {
    name: "stop",
    group: "AI",
    description: "Stop the reply in progress.",
    usage: "!stop",
  },
  update: {
    name: "update",
    group: "App",
    description: "Check for a new version now and install it.",
    usage: "!update",
  },
  dashboard: {
    name: "dashboard",
    group: "App",
    description: "Get a one-time link that connects this chat to your dashboard account",
    usage: "!dashboard",
  },
  app: {
    name: "app",
    group: "App",
    description: "Get a one-time link that signs the BellaClaw app in with this chat",
    usage: "!app",
  },
} satisfies Record<string, TCommandEntry>;

export const SCommandState = z.enum(["running", "done", "failed"]);

export type TCommandState = z.infer<typeof SCommandState>;

export const SCommandTone = z.enum(["neutral", "good", "warning", "bad"]);

export type TCommandTone = z.infer<typeof SCommandTone>;

// one item a command lists, as a card row
export const SCommandRow = z
  .object({
    title: z.string(),
    status: z.object({ label: z.string(), tone: SCommandTone }).strict().optional(),
    detail: z.string().optional(),
  })
  .strict();

export type TCommandRow = z.infer<typeof SCommandRow>;

// one run of a command, on its request row and each of its reply and notice rows: the JSON of
// memories.command, and the `command` of events, history rows and the stream. runId: the id of the
// message.authorized event that ran it; name: its catalog name, without "!"
export const SCommandRun = z
  .object({
    runId: z.string(),
    name: z.string(),
    state: SCommandState,
    outcome: z.string().optional(),
    rows: z.array(SCommandRow).optional(),
  })
  .strict();

export type TCommandRun = z.infer<typeof SCommandRun>;

// GET /api/commands response: the catalog, in its order
export const SGatewayCommands = z.object({ commands: z.array(SCommandEntry) }).strict();

export type TGatewayCommands = z.infer<typeof SGatewayCommands>;
