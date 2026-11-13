import { AutomationError } from "../../automation/types";
import { CommandRejectedError } from "../../events";
import { ToolError } from "./define-tool";

/**
 * Runs an automation service call or command; its failures become tool errors with their
 * stable code.
 */
export async function runAutomationOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AutomationError) {
      throw new ToolError(error.code, error.message);
    }

    if (error instanceof CommandRejectedError) {
      throw new ToolError(error.errorCode ?? error.code, error.message);
    }

    throw error;
  }
}
