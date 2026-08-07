import { describe, expect, test } from "bun:test";
import type { TOption } from "@bellaclaw/shared";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DefaultConfigRecord } from "../../settings/schema";
import { AgentHarness, EAgentName } from "../agent-harness";
import { EModelPurpose } from "../types";
import { AGENT_TOOL_NAMES } from "./permissions";

describe("agent permissions", () => {
  test("matches the six-agent tool matrix without specialist delegation", () => {
    expect(AGENT_TOOL_NAMES[EAgentName.Calendar]).toEqual([
      "list-calendars",
      "remove-readonly-calendar",
      "list-calendar-events",
      "find-calendar-availability",
      "create-calendar-event",
      "update-calendar-event",
      "delete-calendar-event",
      "web-search",
      "web-fetch",
    ]);
    expect(AGENT_TOOL_NAMES[EAgentName.Main]).toEqual([
      "web-search",
      "web-fetch",
      "delegate-calendar",
      "delegate-memory",
      "delegate-settings",
      "delegate-scheduling",
    ]);
    expect(AGENT_TOOL_NAMES[EAgentName.Memory]).toEqual(["search-memory"]);
    expect(AGENT_TOOL_NAMES[EAgentName.Settings]).toEqual(["get-settings", "update-settings"]);
    expect(AGENT_TOOL_NAMES[EAgentName.Scheduling]).toEqual([
      "list-cron-jobs",
      "schedule-once",
      "schedule-recurring",
      "update-cron-job",
      "unschedule-cron-job",
      "web-search",
      "web-fetch",
    ]);
    expect(AGENT_TOOL_NAMES[EAgentName.ScheduledTask]).toEqual([
      "search-memory",
      "web-search",
      "web-fetch",
      "list-calendar-events",
      "find-calendar-availability",
    ]);

    for (const name of [
      EAgentName.Memory,
      EAgentName.Settings,
      EAgentName.Scheduling,
      EAgentName.ScheduledTask,
      EAgentName.Calendar,
    ]) {
      expect(AGENT_TOOL_NAMES[name].some((tool) => tool.startsWith("delegate-"))).toBe(false);
    }
  });

  test("assembles the production tools and execution modes for every agent", async () => {
    const harness = AgentHarness.instance as unknown as {
      createTools(args: {
        name: EAgentName;
        purpose: EModelPurpose;
        prompt: string;
        chatId: string;
        settings: typeof DefaultConfigRecord;
        currentTimeContext: undefined;
        platform: undefined;
        trace: undefined;
        history: [];
        maxIterations: number;
        parentToolCallId: TOption<string>;
        signal: TOption<AbortSignal>;
        delegationCount: TOption<() => void>;
      }): Promise<AgentTool[]>;
    };

    for (const name of Object.values(EAgentName)) {
      let delegationCount: TOption<() => void>;

      if (name === EAgentName.Main) {
        delegationCount = () => undefined;
      }

      const tools = await harness.createTools({
        name,
        purpose: EModelPurpose.Main,
        prompt: "test",
        chatId: "discord:1",
        settings: DefaultConfigRecord,
        currentTimeContext: undefined,
        platform: undefined,
        trace: undefined,
        history: [],
        maxIterations: 30,
        parentToolCallId: undefined,
        signal: undefined,
        delegationCount,
      });

      expect(tools.map((tool) => tool.name)).toEqual([...AGENT_TOOL_NAMES[name]]);
      expect(tools.some((tool) => tool.name.startsWith("delegate-"))).toBe(
        name === EAgentName.Main,
      );

      for (const tool of tools) {
        if (
          tool.name === "delegate-scheduling" ||
          tool.name === "delegate-calendar" ||
          tool.name === "remove-readonly-calendar" ||
          tool.name === "create-calendar-event" ||
          tool.name === "update-calendar-event" ||
          tool.name === "delete-calendar-event" ||
          tool.name === "update-settings" ||
          tool.name === "schedule-once" ||
          tool.name === "schedule-recurring" ||
          tool.name === "update-cron-job" ||
          tool.name === "unschedule-cron-job"
        ) {
          expect(tool.executionMode).toBe("sequential");
        }
      }
    }
  });
});
