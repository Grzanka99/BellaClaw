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
  return REGISTERED_COMMANDS.map((command) => `- ${command.usage} — ${command.description}`).join(
    "\n",
  );
}

export async function runCommand(
  chatId: string,
  address: TChatAddress,
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

  return command.handler(chatId, args, ctx, address);
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
    let result: TOption<TCommandResult>;

    // NOTE: commands act for the owner: its calendars, credentials and logins; activation is
    // per address. A plain chat has none: its "!" messages are text for the model
    if (origin.kind === EConversationKind.Bella) {
      result = await runCommand(
        origin.ownerKey,
        { channel: origin.channel, address: origin.replyAddress },
        content,
        ctx,
      );
    }

    await ctx.complete(async (_tx, emit) => {
      if (typeof result === "string") {
        emit(
          EEventType.ReplyReady,
          {
            ...origin,
            text: result,
            display: { text: result, request: { text: content, receivedAt, clientMessageId } },
          },
          undefined,
          undefined,
        );
        return;
      }

      if (result !== undefined && "confidential" in result) {
        emit(
          EEventType.ReplyReady,
          { ...origin, text: result.confidential, confidential: true },
          undefined,
          undefined,
        );
        return;
      }

      let prompt = content;
      let images = attachments;
      if (result !== undefined) {
        prompt = result.prompt;
        images = [];
      }

      emit(
        EEventType.TurnRequested,
        { ...origin, content: prompt, attachments: images, receivedAt, clientMessageId, model },
        undefined,
        undefined,
      );
    });

    // a command takes no image: nothing references the files its message came with
    if (result !== undefined) {
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
