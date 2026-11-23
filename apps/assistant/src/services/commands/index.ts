import { EConversationKind, EEventType } from "@bellaclaw/database";
import { createLogger, type TLogger, type TOption } from "@bellaclaw/shared";
import { ESubscriptionMode, EventBus, type TEventContext } from "../events";
import type { TEvent } from "../events/catalog";
import type { TChatAddress } from "../identity";
import { MessagingAdapter } from "../messaging";
import { aiAuthCommand } from "./ai-auth";
import { calendarAddReadCommand, calendarAddWriteCommand } from "./calendar-add";
import { connectorCommand } from "./connector";
import { connectorAuthCommand } from "./connector-auth";
import { appCommand, dashboardCommand } from "./dashboard";
import { mcpPromptCommand, mcpPromptsCommand } from "./mcp-prompts";
import { COMMAND_PREFIX, type TCommand, type TCommandResult } from "./types";
import { updateCommand } from "./update";

const REGISTERED_COMMANDS: TCommand[] = [
  calendarAddWriteCommand,
  calendarAddReadCommand,
  connectorCommand,
  connectorAuthCommand,
  mcpPromptsCommand,
  mcpPromptCommand,
  aiAuthCommand,
  updateCommand,
  dashboardCommand,
  appCommand,
];

export function formatCommandList(): string {
  return REGISTERED_COMMANDS.map(
    (command) => `- ${command.entry.usage} — ${command.entry.description}`,
  ).join("\n");
}

export async function runCommand(
  chatId: string,
  address: TChatAddress,
  content: string,
  ctx: TEventContext,
  runId: string,
): Promise<TOption<{ name: string; result: TCommandResult }>> {
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

  const command = REGISTERED_COMMANDS.find(
    (candidate) => candidate.entry.name === name.toLowerCase(),
  );

  if (command === undefined) {
    return undefined;
  }

  return {
    name: command.entry.name,
    result: await command.handler(chatId, args, ctx, address, runId),
  };
}

export class Commands {
  private static _instance: TOption<Commands>;
  private logger: TLogger = createLogger("COMMANDS");

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
    const { content, attachments, receivedAt, clientMessageId, model, ...origin } = event.payload;
    let ran: TOption<{ name: string; result: TCommandResult }>;

    // NOTE: commands act for the owner: its calendars, credentials and logins; activation is
    // per address. A plain chat has none: its "!" messages are text for the model
    if (origin.kind === EConversationKind.Bella) {
      ran = await runCommand(
        origin.ownerKey,
        { channel: origin.channel, address: origin.replyAddress },
        content,
        ctx,
        event.id,
      );
    }

    await ctx.complete(async (_tx, emit) => {
      const runId = event.id;
      const request = { text: content, receivedAt, clientMessageId };
      let prompt = content;
      let images = attachments;

      if (ran !== undefined) {
        const { name, result } = ran;

        if ("prompt" in result) {
          prompt = result.prompt;
          images = [];
        } else if ("confidential" in result) {
          // the secret is only in the text; the stored card holds the command's name and outcome
          emit(
            EEventType.ReplyReady,
            {
              ...origin,
              text: result.confidential,
              confidential: true,
              display: {
                text: result.outcome,
                request: { ...request, text: `${COMMAND_PREFIX}${name}` },
                command: { runId, name, state: result.state, outcome: result.outcome },
              },
            },
            undefined,
            undefined,
          );
          return;
        } else {
          emit(
            EEventType.ReplyReady,
            {
              ...origin,
              text: result.text,
              display: {
                text: result.text,
                request,
                command: {
                  runId,
                  name,
                  state: result.state,
                  outcome: result.outcome,
                  rows: result.rows,
                },
              },
            },
            undefined,
            undefined,
          );
          return;
        }
      }

      emit(
        EEventType.TurnRequested,
        { ...origin, content: prompt, attachments: images, receivedAt, clientMessageId, model },
        undefined,
        undefined,
      );
    });

    // a command takes no image: nothing references the files its message came with
    if (ran !== undefined) {
      for (const ref of attachments) {
        try {
          await MessagingAdapter.instance.deleteAttachment(ref);
        } catch (error) {
          this.logger.warning(`Attachment delete failed: ${String(error)}`);
        }
      }
    }
  }
}
