import type { ToolDefinitionJson } from "@openrouter/sdk/models/tooldefinitionjson";
import { z } from "zod";
import type { TUserData } from "..";

export const SOnetimeReminderParams = z.object({
  trigger_at: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      "Must be an ISO 8601 datetime string (e.g., '2024-03-15T09:00:00')",
    ),
  instructions: z.string().min(1),
  timezone: z
    .string()
    .regex(
      /^[A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/,
      "Must be an IANA timezone identifier (e.g., 'Europe/Warsaw', 'America/New_York')",
    ),
  user_id: z
    .string()
    .regex(/^\d{17,20}$/, "Must be a valid Discord user ID (17-20 digit snowflake)"),
});

export type TOnetimeReminderParams = z.infer<typeof SOnetimeReminderParams>;

export const onetimeReminderTool: ToolDefinitionJson = {
  type: "function",
  function: {
    name: "onetime_reminder",
    description:
      "Create a one-time reminder that triggers at a specific datetime. Use this for reminders that should occur once. For recurring reminders, use recurring_reminder instead.",
    parameters: {
      type: "object",
      properties: {
        trigger_at: {
          type: "string",
          description:
            "ISO 8601 datetime string for when the reminder should trigger (e.g., '2024-03-15T09:00:00')",
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
      required: ["trigger_at", "instructions", "timezone", "user_id"],
    },
  },
};

export function handleOnetimeReminder(rawArgs: unknown, user: TUserData): boolean {
  const parsed = SOnetimeReminderParams.safeParse(rawArgs);

  if (!parsed.success) {
    console.log("asdlkjasdlkj");
    return false;
  }

  const data = { ...parsed.data, user_id: user.id };
  console.log("[handleOnetimeReminder]", data);
  return true;
}
