import { type Static, Type } from "@earendil-works/pi-ai";
import { createToolDefinition } from "../definition";

export const SForgetMemoryArgs = Type.Object(
  {
    factIds: Type.Array(Type.Integer({ minimum: 1 }), {
      minItems: 1,
      uniqueItems: true,
      description: "Unique IDs of the resolved live facts to forget",
    }),
  },
  { additionalProperties: false },
);

export type TForgetMemoryArgs = Static<typeof SForgetMemoryArgs>;

export const FORGET_MEMORY_TOOL = "forget-memory";

export const forgetMemoryTool = createToolDefinition(
  FORGET_MEMORY_TOOL,
  "Forget one or more resolved live conversation facts.",
  SForgetMemoryArgs,
);
