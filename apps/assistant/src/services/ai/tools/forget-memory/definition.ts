import { arr, int, obj, type Static } from "@earendil-works/pi-schema";
import { createToolDefinition } from "../definition";

export const SForgetMemoryArgs = obj({
  factIds: arr(int({ minimum: 1 }), {
    minItems: 1,
    uniqueItems: true,
    description: "Unique IDs of the resolved live facts to forget",
  }),
});

export type TForgetMemoryArgs = Static<typeof SForgetMemoryArgs>;

export const FORGET_MEMORY_TOOL = "forget-memory";

export const forgetMemoryTool = createToolDefinition(
  FORGET_MEMORY_TOOL,
  "Forget one or more resolved live conversation facts.",
  SForgetMemoryArgs,
);
