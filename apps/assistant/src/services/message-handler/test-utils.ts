import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { AgentHarness } from "../ai/agent-harness";

// a scripted model's completed turn: the earlier entries, the prompt and text as the reply
export function scriptedReply(args: Parameters<AgentHarness["runMain"]>[0], text: string) {
  const messages: Message[] = [
    ...(args.conversation?.entries.map((entry) => entry.message) ?? []),
    { role: "user", content: args.prompt, timestamp: Date.now() },
    fauxAssistantMessage(text),
  ];
  return { text, iterations: 1, toolCallCount: 0, stopReason: "completed", messages };
}
