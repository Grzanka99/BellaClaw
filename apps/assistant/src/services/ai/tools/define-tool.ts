import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import type { AgentTool, AgentToolResult, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import { compile, type Schema, type Static } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import type { TConfigRecord } from "../../settings/schema";
import type { EModelPurpose } from "../types";

export type TToolExecutionContext = {
  chatId: TOption<string>;
  settings: TConfigRecord;
  trace: TBehaviorTraceContext;
  verifySettings: (settings: TConfigRecord, purposes: EModelPurpose[]) => Promise<TOption<string>>;
};

export type TTool = {
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
  execute: (
    context: TToolExecutionContext,
    args: Static<T>,
    signal: TOption<AbortSignal>,
  ) => Promise<unknown>;
}): TTool {
  return {
    name: definition.name,
    instructions: definition.instructions,
    createAgentTool: (context) => ({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.schema,
      executionMode: definition.mode,
      execute: async (_toolCallId, args, signal): Promise<AgentToolResult<unknown>> => {
        const details = await definition.execute(
          context,
          validateToolArguments(definition.schema, args),
          signal,
        );

        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      },
    }),
  };
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
