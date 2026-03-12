import type { ToolDefinitionJson } from "@openrouter/sdk/models/tooldefinitionjson";
import { z } from "zod";
import type { TUserData } from "../index.ts";

export const SRecurringReminderParams = z.object({
  cron: z
    .string()
    .describe(
      "Cron expression defining when the reminder should trigger (e.g., '0 9 * * 1-5' for weekdays at 9:00)",
    ),
  instructions: z
    .string()
    .describe("Instructions for the bot on what to say or do when the reminder triggers"),
  timezone: z
    .string()
    .describe("IANA timezone identifier (e.g., 'Europe/Warsaw', 'America/New_York')"),
  user_id: z.string().describe("Discord user ID to send the reminder to"),
});

export type TRecurringReminderParams = z.infer<typeof SRecurringReminderParams>;

export const recurringReminderTool: ToolDefinitionJson = {
  type: "function",
  function: {
    name: "recurring_reminder",
    description:
      "Schedule a recurring reminder using cron syntax. Use this for reminders that should repeat on a schedule. For one-time reminders, use onetime_reminder instead.",
    parameters: {
      type: "object",
      properties: {
        cron: {
          type: "string",
          description:
            "Cron expression defining when the reminder should trigger (e.g., '0 9 * * 1-5' for weekdays at 9:00)",
        },
        instructions: {
          type: "string",
          description: "Instructions for the bot on what to say or do when the reminder triggers",
        },
        timezone: {
          type: "string",
          description: "IANA timezone identifier (e.g., 'Europe/Warsaw', 'America/New_York')",
        },
        user_id: {
          type: "string",
          description: "Discord user ID to send the reminder to",
        },
      },
      required: ["cron", "instructions", "timezone", "user_id"],
    },
  },
};

export function handleRecurringReminder(rawArgs: unknown, user: TUserData): boolean {
  const parsed = SRecurringReminderParams.safeParse(rawArgs);

  if (!parsed.success) {
    console.log("[handleRecurringReminder] Invalid arguments:", parsed.error.format());
    return false;
  }

  const data = { ...parsed.data, user_id: user.id };

  console.log("[handleRecurringReminder]", data);

  return true;
}
