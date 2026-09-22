import type { TOption } from "@bellaclaw/shared";
import { calendarAddReadCommand } from "./calendar-add-read";
import { calendarAddWriteCommand } from "./calendar-add-write";
import { mcpAuthCommand } from "./mcp-auth";
import { mcpPromptCommand, mcpPromptsCommand } from "./mcp-prompts";
import { COMMAND_PREFIX, type TCommand, type TCommandResult } from "./types";

const REGISTERED_COMMANDS: TCommand[] = [
  calendarAddWriteCommand,
  calendarAddReadCommand,
  mcpAuthCommand,
  mcpPromptsCommand,
  mcpPromptCommand,
];

export function formatCommandList(): string {
  return REGISTERED_COMMANDS.map((command) => `- ${command.usage} — ${command.description}`).join(
    "\n",
  );
}

export async function runCommand(
  chatId: string,
  content: string,
): Promise<TOption<TCommandResult>> {
  const trimmed = content.trim();

  if (!trimmed.startsWith(COMMAND_PREFIX)) {
    return undefined;
  }

  const separatorIndex = trimmed.search(/\s/);
  let name: string;
  let args: string;

  if (separatorIndex === -1) {
    name = trimmed.slice(COMMAND_PREFIX.length);
    args = "";
  } else {
    name = trimmed.slice(COMMAND_PREFIX.length, separatorIndex);
    args = trimmed.slice(separatorIndex + 1);
  }

  const command = REGISTERED_COMMANDS.find((candidate) => candidate.name === name.toLowerCase());

  if (command === undefined) {
    return undefined;
  }

  return command.handler(chatId, args);
}
