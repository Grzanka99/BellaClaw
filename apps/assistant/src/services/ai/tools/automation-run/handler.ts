import { AutomationService } from "../../../automation";
import {
  EAutomationRunMode,
  runSavedAutomation,
  type TAutomationRunOptions,
} from "../../../automation/runner";
import type { TAutomationRunArgs } from "./definition";

export async function handleAutomationRun(
  chatId: string,
  args: TAutomationRunArgs,
  options: TAutomationRunOptions,
) {
  const automation = await AutomationService.instance.get(chatId, args.name);

  if (automation === undefined) {
    throw new Error(`Automation '${args.name}' not found`);
  }

  const report = await runSavedAutomation(automation, EAutomationRunMode.Manual, options);

  return {
    name: report.name,
    outcome: report.outcome,
    text: report.text,
    data: report.data,
    error: report.error,
    fetched: report.fetches,
    logs: report.logs,
    paused: report.paused,
  };
}
