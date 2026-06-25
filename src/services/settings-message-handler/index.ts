import { createLogger, type TLogger } from "../../utils/logger";
import { AiConnector, EModelPurpose, ERole, type THistoryItem } from "../ai/api";
import { getSettingsTool } from "../ai/tools/get-settings/definition";
import { updateSettingsTool } from "../ai/tools/update-settings/definition";
import { Memory } from "../memory";
import { EMemoryImportance, type TMemory } from "../memory/types";
import type { TIncommingMessage } from "../message-handler/types";
import { SettingsService } from "../settings";
import { createStableAiRuntimeSettings } from "../settings/schema";
import { getSettingsHandlerInstructions } from "./instructions";

const RECENT_MEMORY_LIMIT = 30;

export class SettingsMessageHandler {
  private static _instances = new Map<string, SettingsMessageHandler>();
  private logger: TLogger;
  private ai = AiConnector.instance;
  private memory = Memory.instance;

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
    const runtimeSettings = createStableAiRuntimeSettings(settings);
    const instructions = await getSettingsHandlerInstructions(settings);

    const recent = await this.retrieveMemory(message.chatId);

    const history: THistoryItem[] = [{ role: ERole.System, content: instructions.systemPrompt }];

    for (const el of recent.toReversed()) {
      history.push({
        role: el.author,
        content: el.message,
      });
    }

    await this.memory.save({
      chatId: message.chatId,
      author: ERole.User,
      importance: EMemoryImportance.Low,
      message: message.message.content,
    });

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

    await this.memory.save({
      chatId: message.chatId,
      author: ERole.Assistant,
      importance: EMemoryImportance.Low,
      message: aiRes.finalResponse,
    });

    this.logger.info(
      `handleMessage: done (${(performance.now() - handleMessageStart).toFixed(0)}ms)`,
    );
    return aiRes.finalResponse;
  }

  private async retrieveMemory(chatId: string): Promise<TMemory[]> {
    const start = performance.now();

    const res = await this.memory.findRecent(chatId, RECENT_MEMORY_LIMIT);

    if (!res.success) {
      this.logger.error(
        `retrieveMemory: failed to retrieve last ${RECENT_MEMORY_LIMIT} memories (${(performance.now() - start).toFixed(0)}ms)`,
      );
      return [];
    }

    this.logger.info(`retrieveMemory: done (${(performance.now() - start).toFixed(0)}ms)`);
    return res.data;
  }
}
