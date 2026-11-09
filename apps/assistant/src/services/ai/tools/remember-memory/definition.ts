import { arr, int, obj, type Static, str } from "@earendil-works/pi-schema";
import { createToolDefinition } from "../definition";

export const SRememberMemoryArgs = obj({
  fact: str({
    minLength: 1,
    pattern: "\\S",
    description: "One durable fact to remember",
  }),
  sourceMessage: str({
    minLength: 1,
    pattern: "\\S",
    description: "Exact user transcript message that stated the fact",
  }),
  supersedesFactIds: arr(int({ minimum: 1 }), {
    uniqueItems: true,
    description: "Live fact IDs this fact replaces; empty when it replaces none",
  }),
});

export type TRememberMemoryArgs = Static<typeof SRememberMemoryArgs>;

export const REMEMBER_MEMORY_TOOL = "remember-memory";

export const rememberMemoryTool = createToolDefinition(
  REMEMBER_MEMORY_TOOL,
  "Store one explicit durable conversation fact.",
  SRememberMemoryArgs,
);
