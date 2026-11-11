import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import type { AgentTool, AgentToolResult, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import { compile, type Schema, type Static } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import type { TConfigRecord } from "../../settings/schema";
import type { AgentHarness } from "../agent-harness";
import type { EModelPurpose } from "../types";

export type TToolExecutionContext = {
  chatId: TOption<string>;
  settings: TConfigRecord;
  trace: TBehaviorTraceContext;
  verifySettings: (settings: TConfigRecord, purposes: EModelPurpose[]) => Promise<TOption<string>>;
  runScheduledTask: AgentHarness["runScheduledTask"];
};

/**
 * A field whose value may be logged as-is. A tuple logs it under another metadata key.
 */
export type TLogSafeField = string | readonly [field: string, logKey: string];

export type TToolLogPolicy = {
  logSafe: ReadonlyArray<TLogSafeField>;
  /** Error text can quote private values, so only ToolError codes are logged. */
  privateErrors: boolean;
  /** String fields also logged as a bounded, secret-redacted `<key>Preview`. */
  previews?: ReadonlyArray<string>;
};

export type TTool = TToolLogPolicy & {
  name: string;
  instructions: string;
  createAgentTool: (context: TToolExecutionContext) => AgentTool;
};

export function defineTool<T extends Schema>(definition: {
  name: string;
  label: string;
  description: string;
  schema: T;
  instructions: string;
  mode: ToolExecutionMode;
  logSafe: ReadonlyArray<TLogSafeField>;
  privateErrors?: boolean;
  execute: (
    context: TToolExecutionContext,
    args: Static<T>,
    signal: TOption<AbortSignal>,
  ) => Promise<unknown>;
}): TTool {
  return {
    name: definition.name,
    instructions: definition.instructions,
    logSafe: definition.logSafe,
    privateErrors: definition.privateErrors ?? false,
    createAgentTool: (context) => ({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.schema,
      executionMode: definition.mode,
      execute: async (_toolCallId, args, signal): Promise<AgentToolResult<unknown>> => {
        try {
          const details = await definition.execute(
            context,
            validateToolArguments(definition.schema, args),
            signal,
          );

          return { content: [{ type: "text", text: JSON.stringify(details) }], details };
        } catch (error) {
          if (error instanceof ToolError) {
            return {
              content: [{ type: "text", text: error.message }],
              details: { errorCode: error.code },
              isError: true,
            };
          }

          throw error;
        }
      },
    }),
  };
}

/**
 * A tool error with a stable code, so logs record the code instead of the message.
 */
export class ToolError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function requireChatId(chatId: TOption<string>): string {
  if (chatId === undefined) {
    throw new Error("This tool requires a chat owner");
  }

  return chatId;
}

export function validateToolArguments<T extends Schema>(schema: T, args: unknown) {
  const validator = compile(schema, { formats });

  if (validator.check(args)) {
    return args;
  }

  const [failure] = validator.errors(args);
  let location = failure?.path ?? "";

  if (location === "") {
    location = "(root)";
  }

  throw new Error(`Invalid tool arguments: ${location}: ${failure?.message ?? "schema mismatch"}`);
}
