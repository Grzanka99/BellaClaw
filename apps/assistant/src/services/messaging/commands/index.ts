import type { TOption } from "@bellaclaw/shared";
import { calendarAddReadCommand } from "./calendar-add-read";
import { calendarAddWriteCommand } from "./calendar-add-write";
import { COMMAND_PREFIX, type TCommand } from "./types";

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const REGISTERED_COMMANDS: TCommand[] = [calendarAddWriteCommand, calendarAddReadCommand];

const COMMANDS = new Map<string, TCommand>(
  REGISTERED_COMMANDS.map((command) => [command.name, command]),
);

export function formatCommandList(): string {
  return REGISTERED_COMMANDS.map(
    (command) => `- ${escapeXml(command.usage)} — ${escapeXml(command.description)}`,
  ).join("\n");
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
