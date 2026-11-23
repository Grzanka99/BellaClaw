import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { loadConnectors } from "../../connectors/config";
import { testEventRequester } from "../../events/test-utils";
import { DefaultConfigRecord } from "../../settings/schema";
import { AgentHarness } from "../agent-harness";
import type { TAgentRunArgs } from "../agent-harness/types";
import { EAgentName } from ".";

const TEST_TRACE: TBehaviorTraceContext = {
  turnId: "test",
  chatId: undefined,
  platform: undefined,
};

const EXPECTED_TOOL_NAMES: Record<EAgentName, readonly string[]> = {
  [EAgentName.Automations]: [
    "automation-list",
    "automation-get",
    "automation-preview",
    "automation-save",
    "automation-run",
    "automation-set-status",
    "automation-delete",
    "web-search",
    "web-fetch",
  ],
  [EAgentName.Calendar]: [
    "list-calendars",
    "remove-readonly-calendar",
    "list-calendar-events",
    "find-calendar-availability",
    "create-calendar-event",
    "update-calendar-event",
    "delete-calendar-event",
    "web-search",
    "web-fetch",
  ],
  [EAgentName.Lists]: ["list-lists", "update-lists"],
  [EAgentName.Main]: [
    "web-search",
    "web-fetch",
    "delegate-calendar",
    "delegate-memory",
    "delegate-settings",
    "delegate-scheduling",
    "delegate-automations",
    "delegate-lists",
    "delegate-connector-manager",
  ],
  [EAgentName.Connector]: [],
  [EAgentName.ConnectorManager]: [
    "list-connectors",
    "add-connector",
    "update-connector",
    "remove-connector",
  ],
  [EAgentName.Memory]: ["search-memory", "remember-memory", "forget-memory"],
  [EAgentName.Plain]: ["web-search", "web-fetch"],
  [EAgentName.Settings]: ["get-settings", "update-settings"],
  [EAgentName.Scheduling]: [
    "list-cron-jobs",
    "schedule-once",
    "schedule-recurring",
    "update-cron-job",
    "preview-cron-job",
    "unschedule-cron-job",
    "web-search",
    "web-fetch",
  ],
  [EAgentName.ScheduledTask]: [
    "search-memory",
    "web-search",
    "web-fetch",
    "list-calendar-events",
    "find-calendar-availability",
    "list-cron-jobs",
  ],
};

describe("agent permissions", () => {
  test("assembles the production tools and execution modes for every agent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bellaclaw-permissions-"));
    const configPath = join(directory, "connectors.json");
    const previousConfigPath = Bun.env.BELLACLAW_CONNECTORS_CONFIG;
    Bun.env.BELLACLAW_CONNECTORS_CONFIG = configPath;
    const harness = AgentHarness.instance as unknown as {
      createTools(
        args: TAgentRunArgs & { delegationCount: TOption<() => void> },
      ): Promise<AgentTool[]>;
    };

    try {
      for (const name of Object.values(EAgentName)) {
        let delegationCount: TOption<() => void>;

        if (name === EAgentName.Main) {
          delegationCount = () => undefined;
        }

        const tools = await harness.createTools({
          name,
          prompt: "test",
          conversationKey: "discord:1",
          ownerKey: "discord:1",
          settings: DefaultConfigRecord,
          currentTimeContext: undefined,
          platform: undefined,
          trace: TEST_TRACE,
          events: testEventRequester,
          parentToolCallId: undefined,
          signal: undefined,
          delegationCount,
        });

        expect(tools.map((tool) => tool.name)).toEqual([...EXPECTED_TOOL_NAMES[name]]);
        expect(tools.some((tool) => tool.name.startsWith("delegate-"))).toBe(
          name === EAgentName.Main,
        );

        for (const tool of tools) {
          if (
            tool.name === "delegate-scheduling" ||
            tool.name === "delegate-automations" ||
            tool.name === "automation-preview" ||
            tool.name === "automation-save" ||
            tool.name === "automation-run" ||
            tool.name === "automation-set-status" ||
            tool.name === "automation-delete" ||
            tool.name === "remember-memory" ||
            tool.name === "forget-memory" ||
            tool.name === "delegate-calendar" ||
            tool.name === "remove-readonly-calendar" ||
            tool.name === "create-calendar-event" ||
            tool.name === "update-calendar-event" ||
            tool.name === "delete-calendar-event" ||
            tool.name === "update-settings" ||
            tool.name === "schedule-once" ||
            tool.name === "schedule-recurring" ||
            tool.name === "update-cron-job" ||
            tool.name === "unschedule-cron-job" ||
            tool.name === "delegate-lists" ||
            tool.name === "update-lists" ||
            tool.name === "delegate-connector-manager" ||
            tool.name === "add-connector" ||
            tool.name === "update-connector" ||
            tool.name === "remove-connector"
          ) {
            expect(tool.executionMode).toBe("sequential");
          }
        }
      }

      await Bun.write(
        configPath,
        JSON.stringify({
          connectors: [
            {
              id: "files",
              description: "File operations",
              instructions: "Use the server for file operations",
              transport: { type: "stdio", command: "fixture" },
            },
          ],
        }),
      );
      const configuredTools = await harness.createTools({
        name: EAgentName.Main,
        prompt: "test",
        conversationKey: "discord:1",
        ownerKey: "discord:1",
        settings: DefaultConfigRecord,
        currentTimeContext: undefined,
        platform: undefined,
        trace: TEST_TRACE,
        events: testEventRequester,
        parentToolCallId: undefined,
        signal: undefined,
        delegationCount: () => undefined,
      });

      expect(configuredTools.map((tool) => tool.name).slice(-3)).toEqual([
        "delegate-connector",
        "resume-connector",
        "cancel-connector",
      ]);
      for (const name of ["delegate-connector", "resume-connector", "cancel-connector"]) {
        expect(configuredTools.find((tool) => tool.name === name)?.executionMode).toBe(
          "sequential",
        );
      }
    } finally {
      if (previousConfigPath === undefined) {
        delete Bun.env.BELLACLAW_CONNECTORS_CONFIG;
      } else {
        Bun.env.BELLACLAW_CONNECTORS_CONFIG = previousConfigPath;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("the plain agent has web tools and connectors, with no memory, calendar, scheduling, settings or automation tool and no connector closed to plain chats", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bellaclaw-permissions-"));
    const configPath = join(directory, "connectors.json");
    const previousConfigPath = Bun.env.BELLACLAW_CONNECTORS_CONFIG;
    const harness = AgentHarness.instance as unknown as {
      createTools(
        args: TAgentRunArgs & { delegationCount: TOption<() => void> },
      ): Promise<AgentTool[]>;
    };

    try {
      // the repository's connectors leave plainChats out, so vault and logs are closed to plain chats
      delete Bun.env.BELLACLAW_CONNECTORS_CONFIG;
      const production = await loadConnectors("discord:1");
      expect(production.map((connector) => [connector.id, connector.plainChats]).sort()).toEqual([
        ["logs", false],
        ["vault", false],
      ]);

      Bun.env.BELLACLAW_CONNECTORS_CONFIG = configPath;
      await Bun.write(
        configPath,
        JSON.stringify({
          connectors: [
            ...production,
            {
              id: "notes",
              description: "Personal notes",
              instructions: "Use the server for notes",
              transport: { type: "stdio", command: "fixture" },
            },
            {
              id: "files",
              description: "File operations",
              instructions: "Use the server for file operations",
              transport: { type: "stdio", command: "fixture" },
              plainChats: true,
            },
          ],
        }),
      );
      const tools = await harness.createTools({
        name: EAgentName.Plain,
        prompt: "test",
        conversationKey: "plain:acct-1:chat-1",
        ownerKey: "account:acct-1",
        settings: DefaultConfigRecord,
        currentTimeContext: undefined,
        platform: undefined,
        trace: TEST_TRACE,
        events: testEventRequester,
        parentToolCallId: undefined,
        signal: undefined,
        delegationCount: () => undefined,
      });

      expect(tools.map((tool) => tool.name)).toEqual([
        "web-search",
        "web-fetch",
        "delegate-connector",
        "resume-connector",
        "cancel-connector",
      ]);
      const delegate = tools.find((tool) => tool.name === "delegate-connector");
      expect(delegate?.description).toContain("files: File operations");
      expect(delegate?.description).not.toContain("vault");
      expect(delegate?.description).not.toContain("logs");
      expect(delegate?.description).not.toContain("notes");

      for (const connectorId of ["vault", "logs", "notes"]) {
        await expect(
          delegate?.execute("call-1", { connectorId, task: "read", context: "none" }),
        ).rejects.toThrow(`Unknown connector: ${connectorId}`);
      }
    } finally {
      if (previousConfigPath === undefined) {
        delete Bun.env.BELLACLAW_CONNECTORS_CONFIG;
      } else {
        Bun.env.BELLACLAW_CONNECTORS_CONFIG = previousConfigPath;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
