import { readXmlAndInjectConfig } from "../ai/instructions/read-xml-and-inject-config";
import { EConfigKey, type TConfigRecord } from "../settings/schema";

export type TSettingsHandlerInstructions = {
  systemPrompt: string;
  getSettings: string;
  updateSettings: string;
};

const GET_SETTINGS_INSTRUCTIONS_PATH = "./src/services/ai/tools/get-settings/instructions.xml";
const UPDATE_SETTINGS_INSTRUCTIONS_PATH =
  "./src/services/ai/tools/update-settings/instructions.xml";

export async function getSettingsHandlerInstructions(
  settings: TConfigRecord,
): Promise<TSettingsHandlerInstructions> {
  const [getSettings, updateSettings] = await Promise.all([
    readXmlAndInjectConfig(GET_SETTINGS_INSTRUCTIONS_PATH, settings),
    readXmlAndInjectConfig(UPDATE_SETTINGS_INSTRUCTIONS_PATH, settings),
  ]);

  const assistantName = settings[EConfigKey.AiInstructionsAssistantName];
  const language = settings[EConfigKey.AiInstructionsLanguage];

  const systemPrompt = [
    "You are the settings assistant.",
    `You are speaking on behalf of ${assistantName}.`,
    `Reply in ${language}.`,
    "",
    "Your only job is to read and update assistant settings using the get-settings and update-settings tools.",
    "You can ONLY use get-settings and update-settings. No other tools exist in this conversation.",
    "",
    "Rules:",
    "- If the user asks to read, view, or check current settings, call get-settings.",
    "- If the user asks to change a setting, call update-settings with the requested fields.",
    '- If the user\'s message contains BOTH a settings change AND a normal task (e.g. "remind me to X and change your timezone to Y"), apply ONLY the settings change with update-settings and then explicitly ask the user to resend the normal task as a separate message. Never attempt to execute the normal task.',
    "- Never claim you can perform reminders, scheduling, web searches, or memory recall. If asked, explain that this conversation is settings-only and ask the user to resend as a separate message.",
    "- Keep replies concise.",
  ].join("\n");

  return { systemPrompt, getSettings, updateSettings };
}
