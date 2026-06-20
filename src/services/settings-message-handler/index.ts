import { createLogger, type TLogger } from "../../utils/logger";
import { AiConnector, EModelPurpose, ERole, type THistoryItem } from "../ai/api";
import { getSettingsTool } from "../ai/tools/get-settings/definition";
import { updateSettingsTool } from "../ai/tools/update-settings/definition";
import type { TIncommingMessage } from "../message-handler/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord, EConfigKey, type TConfigRecord } from "../settings/schema";
import { getSettingsHandlerInstructions } from "./instructions";

export class SettingsMessageHandler {
  private static _instances = new Map<string, SettingsMessageHandler>();
  private logger: TLogger;
  private ai = AiConnector.instance;

  constructor(chatId: string) {
    this.logger = createLogger(`SettingsMessageHandler (cid: ${chatId})`);
    this.logger.info("created settings message handler");
  }

  public static getInstance(chatId: string): SettingsMessageHandler {
    const instance = SettingsMessageHandler._instances.get(chatId);

    if (instance) {
      return instance;
    }

    const newInstance = new SettingsMessageHandler(chatId);
    SettingsMessageHandler._instances.set(chatId, newInstance);

    return newInstance;
  }

  public async handleMessage(message: TIncommingMessage): Promise<string> {
    const handleMessageStart = performance.now();
    this.logger.info("handleMessage: start");

    const settings = await SettingsService.instance.getAll(message.chatId);
    const instructions = await getSettingsHandlerInstructions(settings);
    const runtimeSettings: TConfigRecord = {
      ...settings,
      [EConfigKey.AiProvider]: DefaultConfigRecord[EConfigKey.AiProvider],
      [EConfigKey.AiProvidersOllamaModelsToolCheap]:
        DefaultConfigRecord[EConfigKey.AiProvidersOllamaModelsToolCheap],
      [EConfigKey.AiProvidersOllamaModelsToolAccurate]:
        DefaultConfigRecord[EConfigKey.AiProvidersOllamaModelsToolAccurate],
      [EConfigKey.AiProvidersOllamaModelsGeneral]:
        DefaultConfigRecord[EConfigKey.AiProvidersOllamaModelsGeneral],
      [EConfigKey.AiProvidersOllamaModelsChat]:
        DefaultConfigRecord[EConfigKey.AiProvidersOllamaModelsChat],
      [EConfigKey.AiProvidersOllamaModelsChatAccurate]:
        DefaultConfigRecord[EConfigKey.AiProvidersOllamaModelsChatAccurate],
      [EConfigKey.AiProvidersOpenrouterModelsToolCheap]:
        DefaultConfigRecord[EConfigKey.AiProvidersOpenrouterModelsToolCheap],
      [EConfigKey.AiProvidersOpenrouterModelsToolAccurate]:
        DefaultConfigRecord[EConfigKey.AiProvidersOpenrouterModelsToolAccurate],
      [EConfigKey.AiProvidersOpenrouterModelsGeneral]:
        DefaultConfigRecord[EConfigKey.AiProvidersOpenrouterModelsGeneral],
      [EConfigKey.AiProvidersOpenrouterModelsChat]:
        DefaultConfigRecord[EConfigKey.AiProvidersOpenrouterModelsChat],
      [EConfigKey.AiProvidersOpenrouterModelsChatAccurate]:
        DefaultConfigRecord[EConfigKey.AiProvidersOpenrouterModelsChatAccurate],
      [EConfigKey.AiProvidersOpencodeGoModelsToolCheap]:
        DefaultConfigRecord[EConfigKey.AiProvidersOpencodeGoModelsToolCheap],
      [EConfigKey.AiProvidersOpencodeGoModelsToolAccurate]:
        DefaultConfigRecord[EConfigKey.AiProvidersOpencodeGoModelsToolAccurate],
      [EConfigKey.AiProvidersOpencodeGoModelsGeneral]:
        DefaultConfigRecord[EConfigKey.AiProvidersOpencodeGoModelsGeneral],
      [EConfigKey.AiProvidersOpencodeGoModelsChat]:
        DefaultConfigRecord[EConfigKey.AiProvidersOpencodeGoModelsChat],
      [EConfigKey.AiProvidersOpencodeGoModelsChatAccurate]:
        DefaultConfigRecord[EConfigKey.AiProvidersOpencodeGoModelsChatAccurate],
    };

    const history: THistoryItem[] = [{ role: ERole.System, content: instructions.systemPrompt }];

    const tools = [
      { definition: getSettingsTool, instructions: instructions.getSettings },
      { definition: updateSettingsTool, instructions: instructions.updateSettings },
    ];

    const chatStart = performance.now();
    const aiRes = await this.ai.runAssistantToolLoop({
      prompt: {
        role: ERole.User,
        content: [{ type: "text", text: message.message.content }],
      },
      history,
      purpose: EModelPurpose.ChatAccurate,
      user: {
        username: message.author.username,
        id: message.author.id,
        displayName: message.author.username,
      },
      tools,
      chatId: message.chatId,
      settings: runtimeSettings,
    });
    this.logger.info(
      `handleMessage: AI chat completed (${(performance.now() - chatStart).toFixed(0)}ms)`,
    );

    if (aiRes.finalResponse === undefined) {
      this.logger.warning("handleMessage: AI returned no final response");
      return "Something went wrong.";
    }

    this.logger.info(
      `handleMessage: done (${(performance.now() - handleMessageStart).toFixed(0)}ms)`,
    );
    return aiRes.finalResponse;
  }
}
