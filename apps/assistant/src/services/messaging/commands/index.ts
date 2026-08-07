import type { TOption } from "@bellaclaw/shared";
import { CalendarService } from "../../calendar";

export const COMMAND_PREFIX = "!";

export type TCommand = {
  description: string;
  usage: string;
  handler: (chatId: string, args: string) => Promise<string>;
};

export const COMMANDS = new Map<string, TCommand>([
  [
    "write-calendar",
    {
      description:
        "Set the Google calendar the bot writes events to. The calendar must already be shared with the bot's service account with write access. Sending it again replaces the current one.",
      usage: "!write-calendar <calendarId>",
      handler: async (chatId, args) => {
        const calendarId = args.trim();

        if (calendarId.length === 0) {
          return "Usage: !write-calendar <calendarId>";
        }

        try {
          const calendar = await CalendarService.instance.setWriteCalendar(chatId, calendarId);
          return `Write calendar set: ${calendar.summary ?? calendar.calendarId}`;
        } catch (error) {
          return `Can't use that calendar: ${String(error)}`;
        }
      },
    },
  ],
]);

export function formatCommandList(): string {
  return Array.from(COMMANDS.values())
    .map((command) => `- ${command.usage} — ${command.description}`)
    .join("\n");
}

export async function runCommand(chatId: string, content: string): Promise<TOption<string>> {
  const trimmed = content.trim();

  if (!trimmed.startsWith(COMMAND_PREFIX)) {
    return undefined;
  }

  const separatorIndex = trimmed.search(/\s/);
  let name = trimmed.slice(COMMAND_PREFIX.length);
  let args = "";

  if (separatorIndex !== -1) {
    name = trimmed.slice(COMMAND_PREFIX.length, separatorIndex);
    args = trimmed.slice(separatorIndex + 1);
  }

  const command = COMMANDS.get(name.toLowerCase());

  if (command === undefined) {
    return undefined;
  }

  return command.handler(chatId, args);
}
