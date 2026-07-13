import z from "zod";
import type { TOption } from "../../../../types";
import { logger } from "../../../../utils/logger";
import { EMemoryImportance } from "../../../memory/types";

export const SDefineMessageImportance = z.object({
  reasoning: z.string().describe("Brief explanation of why this importance level was chosen"),
  importance: z
    .enum(EMemoryImportance)
    .describe("The importance level of the message: low, medium, or high"),
});

export type TDefineMessageImportance = z.infer<typeof SDefineMessageImportance>;

export function handleDefineMessageImportance(args: unknown): TOption<TDefineMessageImportance> {
  const parsed = SDefineMessageImportance.safeParse(args);

  if (!parsed.success) {
    logger.error("handleDefineMessageImportance: Zod validation failed");
    return undefined;
  }

  return parsed.data;
}
