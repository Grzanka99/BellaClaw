import { beforeEach, describe, expect, test } from "bun:test";
import { join, relative, resolve } from "node:path";
import { EEventType } from "@bellaclaw/database";
import { Glob } from "bun";
import { setupAiAuth } from "../ai/auth";
import { AuthorizationService } from "../authorization";
import { AutomationService } from "../automation";
import { CalendarService } from "../calendar";
import { Commands } from "../commands";
import { CronScheduler } from "../cron";
import { setupInternalApi } from "../internal-api";
import { McpService } from "../mcp";
import { setupMcpAuth } from "../mcp/auth";
import { Memory } from "../memory";
import { FactDistiller } from "../memory/distill";
import { MessageHandler } from "../message-handler";
import { MessagingAdapter } from "../messaging";
import { Notices } from "../notices";
import { ScheduledDelivery } from "../scheduling/delivery";
import { SettingsService } from "../settings";
import { EEventKind, EVENT_KINDS } from "./catalog";
import { ESubscriptionMode, EventBus } from "./index";

const SERVICES = resolve(import.meta.dir, "..");

// Infrastructure every service may use (section 9): the database, the logger, the bus, and the
// cached settings read model.
const INFRASTRUCTURE = new Set(["app-logger", "database", "events", "settings"]);

// Value imports across services that change no state. Key: `<service> -> <module>`.
const ALLOWED: Record<string, string> = {
  "ai -> authorization": "listAuthorizedChatIds, a cached read model",
  "ai -> automation": "reads that prepare a command (resolveNames, get, list); constants",
  "ai -> automation/runner": "dryRunSavedAutomation for previews; run-mode enum and timeout",
  "ai -> calendar": "read tools",
  "ai -> calendar/recurrence": "pure helper",
  "ai -> commands": "formatCommandList, a pure helper for instructions",
  "ai -> conversation/compaction": "compactConversation, the stateless compaction engine",
  "ai -> cron": "CronScheduler.get and list reads; preview dry runs",
  "ai -> embedding": "driver",
  "ai -> mcp": "McpService.open: live sockets",
  "ai -> mcp/config": "profile config reads",
  "ai -> mcp/runs": "McpRunRegistry: live abort controllers and resolvers",
  "ai -> mcp/sampling": "pure request and result mappers",
  "ai -> memory": "Memory.searchFacts read; request timeout and error constants",
  "ai -> messaging/chat-key": "pure functions",
  "ai -> scheduling/cron-automations": "preview dry runs",
  "automation -> ai/tools/automation-summary": "pure mapper",
  "commands -> ai/auth": "status reads",
  "commands -> authorization": "listAuthorizedChatIds, a cached read model",
  "commands -> mcp": "status read: lists a profile's prompts",
  "commands -> mcp/auth": "status read",
  "commands -> mcp/config": "profile config reads",
  "conversation -> ai/instructions/compaction.xml": "prompt text",
  "conversation -> ai/llm": "driver helper",
  "discord -> messaging": "registerTransport: boot wiring of the driver, no stored state",
  "discord -> messaging/chat-key": "pure functions",
  "events -> automation/runner": "enums the catalog payloads use",
  "internal-api -> ai/llm": "driver",
  "internal-api -> ai/model-preferences": "pure helpers",
  "internal-api -> ai/providers/registry": "driver: the model catalog",
  "internal-api -> ai/tools/get-settings": "resolveAiProvider, a pure helper",
  "internal-api -> ai/tools/update-settings/ai-settings":
    "checks and verification that prepare the settings command",
  "mcp -> ai/llm": "driver helper",
  "memory -> ai/llm": "driver",
  "memory -> conversation": "ConversationStore.findChatIds read",
  "memory -> embedding": "driver",
  "message-handler -> ai/agent-harness": "runMain and compactConversation, the stateless engine",
  "message-handler -> conversation": "the same component: Conversation's handler and its store",
  "message-handler -> messaging":
    "fetchAttachment and deleteAttachment: driver calls, no stored state",
  "notices -> authorization": "listAuthorizedChatIds, a cached read model",
  "scheduling -> ai/agent-harness": "runScheduledTask, the stateless engine",
  "scheduling -> ai/instructions/base-system.xml": "prompt text",
  "scheduling -> ai/instructions/platform": "pure prompt helper",
  "scheduling -> ai/instructions/read-xml-and-inject-config": "pure prompt helper",
  "scheduling -> ai/llm": "driver",
  "scheduling -> automation": "getByIds read; failure limit constant",
  "scheduling -> automation/runner": "run-mode and outcome enums, timeout constant",
  "scheduling -> messaging/chat-key": "pure functions",
  "settings -> ai/model-preferences": "pure helpers",
  "signal -> messaging": "registerTransport: boot wiring of the driver, no stored state",
  "signal -> messaging/chat-key": "pure functions",
};

// Who may wait on whom through request() or waitFor() (section 6). A cycle would hang a lane
// until the timeout.
const ALLOWED_WAITS: Record<string, string[]> = {
  conversation: ["cron", "automations", "settings", "memory", "calendar", "ai-auth"],
  // a scheduled task's search-memory tool refreshes the facts first
  scheduling: ["automations", "memory"],
  commands: ["mcp-auth", "ai-auth", "calendar"],
  "ai-auth": ["settings"],
  // an HTTP request, on no lane: it awaits the outcome through live subscriptions
  "internal-api": ["settings", "conversation"],
};

const STATIC_IMPORT =
  /^(?:import|export)\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT = /^import\s+["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /import\(\s*["']([^"']+)["']\s*\)/g;

type TImport = { file: string; specifier: string; typeOnly: boolean };

function scanImports(file: string, source: string): TImport[] {
  const imports: TImport[] = [];

  for (const match of source.matchAll(STATIC_IMPORT)) {
    const clause = match[2] ?? "";
    let typeOnly = match[1] !== undefined;

    if (!typeOnly && clause.startsWith("{")) {
      const names = clause
        .slice(1, -1)
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      typeOnly = names.length > 0 && names.every((name) => name.startsWith("type "));
    }

    imports.push({ file, specifier: match[3] ?? "", typeOnly });
  }

  for (const match of [
    ...source.matchAll(SIDE_EFFECT_IMPORT),
    ...source.matchAll(DYNAMIC_IMPORT),
  ]) {
    imports.push({ file, specifier: match[1] ?? "", typeOnly: false });
  }

  return imports;
}

async function crossServiceImports() {
  const found: { from: string; target: string; file: string }[] = [];

  for await (const file of new Glob("**/*.ts").scan(SERVICES)) {
    if (file.endsWith(".test.ts") || file.endsWith("test-utils.ts") || file.includes("fixtures/")) {
      continue;
    }

    const from = file.split("/")[0] ?? "";
    const source = await Bun.file(join(SERVICES, file)).text();

    for (const imported of scanImports(file, source)) {
      if (imported.typeOnly || !imported.specifier.startsWith(".")) {
        continue;
      }

      const target = relative(SERVICES, resolve(SERVICES, file, "..", imported.specifier))
        .replace(/\.ts$/, "")
        .replace(/\/index$/, "");
      const to = target.split("/")[0] ?? "";

      if (target.startsWith("..") || to === from) {
        continue;
      }

      found.push({ from, target, file });
    }
  }

  return found;
}

describe("boundaries", () => {
  test("a service imports another service's module only for types, infrastructure or the allow-list", async () => {
    const imports = await crossServiceImports();
    const used = new Set<string>();
    const violations: string[] = [];

    for (const { from, target, file } of imports) {
      const pair = `${from} -> ${target}`;

      if (INFRASTRUCTURE.has(target.split("/")[0] ?? "")) {
        continue;
      }

      // definitions: enums, zod schemas and types, no state
      if (/(^|\/)(types|schema)$/.test(target)) {
        continue;
      }

      if (ALLOWED[pair] !== undefined) {
        used.add(pair);
        continue;
      }

      violations.push(`${file}: ${pair}`);
    }

    expect(violations).toEqual([]);
    // an entry nothing needs any more must go
    expect(Object.keys(ALLOWED).filter((pair) => !used.has(pair))).toEqual([]);
  });

  test("the allowed-wait list has no cycle", () => {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const cycles: string[] = [];

    const visit = (node: string, path: string[]) => {
      if (done.has(node)) {
        return;
      }

      if (visiting.has(node)) {
        cycles.push([...path, node].join(" -> "));
        return;
      }

      visiting.add(node);

      for (const next of ALLOWED_WAITS[node] ?? []) {
        visit(next, [...path, node]);
      }

      visiting.delete(node);
      done.add(node);
    };

    for (const node of Object.keys(ALLOWED_WAITS)) {
      visit(node, []);
    }

    expect(cycles).toEqual([]);
  });

  describe("consumers registered as src/index.ts does", () => {
    let bus: EventBus;
    // biome-ignore lint/complexity/useLiteralKeys: a private field, read for the check
    const subscriptions = () => bus["subscriptions"];

    beforeEach(async () => {
      Object.assign(EventBus, { _instance: undefined });
      bus = EventBus.instance;
      // NOTE: the transports and CronScheduler.setup (timers) register no durable consumer
      MessagingAdapter.instance.setup();
      Notices.instance.setup();
      Commands.instance.setup();
      ScheduledDelivery.instance.setup();
      CronScheduler.instance.subscribe();
      AutomationService.instance.setup();
      MessageHandler.instance.setup();
      Memory.instance.setup();
      FactDistiller.instance.setup();
      SettingsService.instance.setup();
      setupAiAuth();
      setupMcpAuth();
      McpService.instance.setup();
      setupInternalApi();
      await AuthorizationService.instance.setup();
      await CalendarService.instance.setup();
    });

    test("this registration follows src/index.ts", async () => {
      const source = await Bun.file(resolve(SERVICES, "../index.ts")).text();
      const calls = [...source.matchAll(/(\w+)\.instance\.(setup|subscribe)\(\)|(setup\w+)\(\)/g)]
        .map((match) => match[3] ?? `${match[1]}.${match[2]}`)
        .filter(
          (call) =>
            !["DiscordSingleton.setup", "SignalSingleton.setup", "CronScheduler.setup"].includes(
              call,
            ),
        );

      expect(calls).toEqual([
        "MessagingAdapter.setup",
        "Notices.setup",
        "Commands.setup",
        "ScheduledDelivery.setup",
        "CronScheduler.subscribe",
        "AutomationService.setup",
        "MessageHandler.setup",
        "Memory.setup",
        "FactDistiller.setup",
        "SettingsService.setup",
        "setupAiAuth",
        "setupMcpAuth",
        "McpService.setup",
        "setupInternalApi",
        "AuthorizationService.setup",
        "CalendarService.setup",
      ]);
    });

    test("every catalog command has exactly one durable consumer", () => {
      const wrong: string[] = [];

      for (const type of Object.values(EEventType)) {
        // test-only commands have no consumer in the app
        if (EVENT_KINDS[type] !== EEventKind.Command || type.startsWith("test.")) {
          continue;
        }

        const consumers = subscriptions().filter(
          (subscription) =>
            subscription.type === type && subscription.mode === ESubscriptionMode.Durable,
        );

        if (consumers.length !== 1) {
          wrong.push(`${type}: ${consumers.length}`);
        }
      }

      expect(wrong).toEqual([]);
    });

    test("every wait in the allowed-wait list points at a command consumer", () => {
      const commandConsumers = new Set(
        subscriptions()
          .filter((subscription) => EVENT_KINDS[subscription.type] === EEventKind.Command)
          .map((subscription) => subscription.consumer),
      );

      expect(
        Object.values(ALLOWED_WAITS)
          .flat()
          .filter((consumer) => !commandConsumers.has(consumer)),
      ).toEqual([]);
    });
  });
});
