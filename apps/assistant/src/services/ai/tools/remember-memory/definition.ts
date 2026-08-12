import { type Static, Type } from "@earendil-works/pi-ai";
import { createToolDefinition } from "../definition";

export const SRememberMemoryArgs = Type.Object(
  {
    fact: Type.String({
      minLength: 1,
      pattern: "\\S",
      description: "One durable fact to remember",
    }),
    supersedesFactIds: Type.Array(Type.Integer({ minimum: 1 }), {
      uniqueItems: true,
      description: "Live fact IDs this fact replaces; empty when it replaces none",
    }),
  },
  { additionalProperties: false },
);

export type TRememberMemoryArgs = Static<typeof SRememberMemoryArgs>;

export const REMEMBER_MEMORY_TOOL = "remember-memory";

export const rememberMemoryTool = createToolDefinition(
  REMEMBER_MEMORY_TOOL,
  "Store one explicit durable conversation fact.",
  SRememberMemoryArgs,
);
