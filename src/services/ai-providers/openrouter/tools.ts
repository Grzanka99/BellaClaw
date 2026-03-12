import { handleOnetimeReminder, onetimeReminderTool } from "./functions/onetime-reminder.ts";
import { handleRecurringReminder, recurringReminderTool } from "./functions/recurring-reminder.ts";
import type { TUserData } from "./index.ts";

export const TOOLS = [recurringReminderTool, onetimeReminderTool] as const;

export const TOOL_HANDLERS: Record<string, (args: unknown, user: TUserData) => boolean> = {
  recurring_reminder: handleRecurringReminder,
  onetime_reminder: handleOnetimeReminder,
};
