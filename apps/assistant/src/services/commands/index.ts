import type { TOption } from "@bellaclaw/shared";
import { ESubscriptionMode, EventBus, type TEventContext } from "../events";
import { EEventType, type TEvent } from "../events/catalog";
import { aiAuthCommand } from "./ai-auth";
import { calendarAddReadCommand, calendarAddWriteCommand } from "./calendar-add";
import { mcpAuthCommand } from "./mcp-auth";
import { mcpPromptCommand, mcpPromptsCommand } from "./mcp-prompts";
import { COMMAND_PREFIX, type TCommand, type TCommandResult } from "./types";

const REGISTERED_COMMANDS: TCommand[] = [
  calendarAddWriteCommand,
  calendarAddReadCommand,
  mcpAuthCommand,
  mcpPromptsCommand,
  mcpPromptCommand,
  aiAuthCommand,
];

export function formatCommandList(): string {
  return REGISTERED_COMMANDS.map((command) => `- ${command.usage} — ${command.description}`).join(
    "\n",
  );
}

export async function runCommand(
  chatId: string,
  content: string,
  ctx: TEventContext,
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

  return command.handler(chatId, args, ctx);
}

export class Commands {
  private static _instance: TOption<Commands>;

  private constructor() {}

  public static get instance() {
    if (!Commands._instance) {
      Commands._instance = new Commands();
    }

    return Commands._instance;
  }

  public setup(): void {
    EventBus.instance.subscribe({
      consumer: "commands",
      type: EEventType.MessageAuthorized,
      mode: ESubscriptionMode.Durable,
      backoffMs: [1_000, 5_000],
      handler: (event, ctx) => this.handleAuthorized(event, ctx),
    });
  }

  private async handleAuthorized(
    event: TEvent<EEventType.MessageAuthorized>,
    ctx: TEventContext,
  ): Promise<void> {
    const { chatId, content, receivedAt, platform } = event.payload;
    const result = await runCommand(chatId, content, ctx);

    await ctx.complete(async (_tx, emit) => {
      if (typeof result === "string") {
        emit(EEventType.ReplyReady, { chatId, text: result }, undefined, undefined);
        return;
      }

      let prompt = content;
      if (result !== undefined) {
        prompt = result.prompt;
      }

      emit(
        EEventType.TurnRequested,
        { chatId, content: prompt, receivedAt, platform },
        undefined,
        undefined,
      );
    });
  }
}
