import { describe, expect, test } from "bun:test";
import type { TOption } from "@bellaclaw/shared";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DefaultConfigRecord } from "../../settings/schema";
import { AgentHarness, EAgentName } from "../agent-harness";
import type { TAgentRunArgs } from "../agent-harness/types";
import { EModelPurpose } from "../types";

const EXPECTED_TOOL_NAMES: Record<EAgentName, readonly string[]> = {
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
  [EAgentName.Main]: [
    "web-search",
    "web-fetch",
    "delegate-calendar",
    "delegate-memory",
    "delegate-settings",
    "delegate-scheduling",
  ],
  [EAgentName.Memory]: ["search-memory", "remember-memory", "forget-memory"],
  [EAgentName.Settings]: ["get-settings", "update-settings"],
  [EAgentName.Scheduling]: [
    "list-cron-jobs",
    "schedule-once",
    "schedule-recurring",
    "update-cron-job",
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
  ],
};

describe("agent permissions", () => {
  test("assembles the production tools and execution modes for every agent", async () => {
    const harness = AgentHarness.instance as unknown as {
      createTools(
        args: TAgentRunArgs & { delegationCount: TOption<() => void> },
      ): Promise<AgentTool[]>;
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

      expect(tools.map((tool) => tool.name)).toEqual([...EXPECTED_TOOL_NAMES[name]]);
      expect(tools.some((tool) => tool.name.startsWith("delegate-"))).toBe(
        name === EAgentName.Main,
      );

      for (const tool of tools) {
        if (
          tool.name === "delegate-scheduling" ||
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
          tool.name === "unschedule-cron-job"
        ) {
          expect(tool.executionMode).toBe("sequential");
        }
      }
    }
  });
});
