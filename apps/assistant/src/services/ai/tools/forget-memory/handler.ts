import { Memory } from "../../../memory";
import type { TForgetMemoryArgs } from "./definition";

export async function handleForgetMemory(chatId: string, args: TForgetMemoryArgs) {
  try {
    return { forgottenFactIds: await Memory.instance.forgetFacts(chatId, args.factIds) };
  } catch (error) {
    throw new Error(`Memory forget failed: ${String(error)}`);
  }
}
