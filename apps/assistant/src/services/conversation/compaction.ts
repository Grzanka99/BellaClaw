import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import {
  type Api,
  contentText,
  type Message,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import {
  calculateContextTokens,
  estimateMessageTokens,
  estimateTextTokens,
} from "@earendil-works/pi-ai/utils/estimate";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import compactionInstructions from "../ai/instructions/compaction.xml" with { type: "text" };
import { conversationMessages, SAttachmentBlock, type TConversation } from "./types";

const COMPACTION_TRIGGER = 65_000;
const CONTEXT_SOFT_LIMIT = 100_000;
const TARGET_TOKENS = 25_000;
const SUMMARY_RESERVE = 4_096;
// NOTE: a stored image is only the "[Image]" marker, but every turn sends the real picture
const IMAGE_TOKENS = 1_500;

// Pi keeps this many tokens of the window free when it sizes the reply
export const CONTEXT_SAFETY_TOKENS = 4_096;
// Pi's allowance for a provider that counts text above its estimate
export const ESTIMATE_MARGIN = 1.15;
export const REMOVED_RESULT = "[Tool result removed to fit the model's context window]";

/**
 * The messages a request can carry in `budget` tokens, as `estimate` counts them. The oldest tool
 * results become a note first, so every call keeps its result; then whole turns before the last
 * user message are left out, oldest first. The turn that message starts is never cut further.
 */
export function fitContext(
  messages: Message[],
  budget: number,
  estimate: (message: Message) => number,
) {
  const estimates = messages.map(estimate);
  const tokensBefore = estimates.reduce((sum, tokens) => sum + tokens, 0);
  if (tokensBefore <= budget) {
    return { messages, tokens: tokensBefore, tokensBefore };
  }

  let tokens = tokensBefore;
  const noted = messages.map((message, index) => {
    if (message.role !== "toolResult" || tokens <= budget) {
      return message;
    }
    const note: Message = { ...message, content: [{ type: "text", text: REMOVED_RESULT }] };
    const saved = (estimates[index] ?? 0) - estimate(note);
    if (saved <= 0) {
      return message;
    }
    estimates[index] = estimate(note);
    tokens -= saved;
    return note;
  });

  const prompt = noted.findLastIndex((message) => message.role === "user");
  const fitted: Message[] = [];
  let dropping = false;
  for (const [index, message] of noted.entries()) {
    // NOTE: a system message declares the tools, so it stays whatever turn it sits in
    if (index >= prompt || message.role === "system") {
      fitted.push(message);
      continue;
    }
    if (message.role === "user") {
      dropping = tokens > budget;
    }
    if (dropping) {
      tokens -= estimates[index] ?? 0;
    } else {
      fitted.push(message);
    }
  }
  return { messages: fitted, tokens, tokensBefore };
}

function estimateTokens(message: Message): number {
  let images = 0;
  if (message.role === "user" && typeof message.content !== "string") {
    images = message.content.filter((block) => SAttachmentBlock.safeParse(block).success).length;
  }
  return estimateMessageTokens(message) + images * IMAGE_TOKENS;
}

// how the summary request shows one message
function summaryRecord(message: Message) {
  let content: string;
  if (typeof message.content === "string") {
    content = message.content;
  } else {
    content = message.content
      .map((block) => {
        if (block.type === "text") {
          return block.text;
        }
        if (block.type === "thinking") {
          return block.thinking;
        }
        if (block.type === "toolCall") {
          return `toolCallId=${block.id} ${block.name}(${JSON.stringify(block.arguments)})`;
        }
        return "[Image]";
      })
      .join("\n");
  }
  if (message.role === "toolResult") {
    return {
      role: message.role,
      timestamp: message.timestamp,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
      content,
    };
  }
  return { role: message.role, timestamp: message.timestamp, content };
}

/**
 * Summarize older complete turns without mutating the stored conversation.
 * force: summarize the previous summary and every entry now, whatever their size, as when two
 * summaries are fused. A forced request that fails on `model` runs once more on `fallback`.
 * Unforced, it summarizes only the oldest turns that fit `model`'s window, and a later compaction
 * takes the rest. A forced request is cut to the window of the model it runs on, so its summary
 * can miss the oldest tool results and turns.
 */
export async function compactConversation(
  state: TConversation,
  models: Models,
  model: Model<Api>,
  fixedTokens: number,
  trace: TBehaviorTraceContext,
  force: boolean,
  fallback: Model<Api>,
) {
  const messages = conversationMessages(state);
  const estimates = messages.map(estimateTokens);
  let tokensBefore = fixedTokens + estimates.reduce((sum, tokens) => sum + tokens, 0);
  const lastMessage = state.entries.at(-1)?.message;
  // Usage before the summary was written describes the old, larger context.
  if (lastMessage?.role === "assistant" && lastMessage.timestamp > state.summaryTimestamp) {
    tokensBefore = Math.max(tokensBefore, calculateContextTokens(lastMessage.usage));
  }
  // Keep room for the summary prompt/output on smaller models too.
  const trigger = Math.min(
    COMPACTION_TRIGGER,
    model.contextWindow - Math.min(model.maxTokens, SUMMARY_RESERVE) - fixedTokens,
  );
  if (!force && tokensBefore < trigger) {
    return undefined;
  }
  if (tokensBefore >= CONTEXT_SOFT_LIMIT) {
    AppLogger.instance.record({
      trace,
      event: "conversation.soft-limit",
      component: "agent-harness",
      level: EBehaviorLogLevel.Warning,
      summary: "Context exceeded soft guardrail; turn completed without interruption",
      metadata: { contextTokens: tokensBefore },
    });
  }
  AppLogger.instance.record({
    trace,
    event: "conversation.compaction.started",
    component: "agent-harness",
    summary: "Compacting completed conversation",
    metadata: { tokensBefore, model: model.id },
  });

  const keepTokens = Math.max(
    0,
    Math.min(TARGET_TOKENS, trigger / 2) - fixedTokens - SUMMARY_RESERVE,
  );
  let cut = state.entries.length;
  let tokens = 0;
  // Retain whole user turns, so a tool result never loses its matching call.
  for (let i = state.entries.length - 1; i >= 0 && !force; i -= 1) {
    const entry = state.entries[i];
    if (entry === undefined) {
      continue;
    }
    tokens += estimates[i + messages.length - state.entries.length] ?? 0;
    if (tokens > keepTokens) {
      break;
    }
    if (entry.message.role === "user") {
      cut = i;
    }
  }
  const budget = (target: Model<Api>) =>
    (target.contextWindow - CONTEXT_SAFETY_TOKENS - SUMMARY_RESERVE) / ESTIMATE_MARGIN -
    estimateTextTokens(compactionInstructions + state.summary);
  const size = (message: Message) => estimateTextTokens(JSON.stringify(summaryRecord(message)));
  let summarizedTokens = 0;
  for (let i = 0; i < cut && !force; i += 1) {
    const entry = state.entries[i];
    if (entry === undefined) {
      continue;
    }
    summarizedTokens += size(entry.message);
    if (summarizedTokens > budget(model)) {
      let next = state.entries
        .slice(0, i + 1)
        .findLastIndex(({ message }) => message.role === "user");
      // an oldest turn above the window is summarized alone, with its tool results cut to fit
      if (next <= 0) {
        next = state.entries.findIndex(
          ({ message }, index) => index > i && message.role === "user",
        );
      }
      if (next > 0) {
        cut = next;
      }
      break;
    }
  }
  if (cut === 0 && state.summary.length === 0) {
    return undefined;
  }

  const summarized = state.entries.slice(0, cut).map(({ message }) => message);
  const request = (target: Model<Api>) => {
    // NOTE: the summary request must fit the window of the model it runs on, like any other
    const fitted = fitContext(summarized, budget(target), size);
    if (fitted.tokens > budget(target)) {
      return undefined;
    }
    return models.completeSimple(
      target,
      {
        systemPrompt: compactionInstructions,
        messages: [
          {
            role: "user",
            content: `Previous summary:\n${state.summary}\n\nConversation:\n${JSON.stringify(fitted.messages.map(summaryRecord))}`,
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: Math.min(Math.floor(0.8 * SUMMARY_RESERVE), target.maxTokens),
        signal: AbortSignal.timeout(120_000),
        // Thinking shares the maxTokens cap and can leave no room for the summary text.
        reasoning: undefined,
        cacheRetention: "none",
        sessionId: crypto.randomUUID(),
      },
    );
  };
  let result = await request(model);
  if (
    force &&
    fallback.id !== model.id &&
    // a request that does not fit is not sent
    (result === undefined ||
      result.stopReason === "error" ||
      result.stopReason === "aborted" ||
      // a provider that reports an input above the window as a normal or length stop
      isContextOverflow(result, model.contextWindow))
  ) {
    result = await request(fallback);
  }
  if (result === undefined) {
    throw new Error("Summary request is larger than the model's context window");
  }
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    throw new Error(result.errorMessage ?? "Conversation summarization failed");
  }
  const diagnostics = `stopReason=${result.stopReason}, output=${result.usage.output}, reasoning=${result.usage.reasoning ?? "n/a"}`;
  if (result.stopReason === "length") {
    throw new Error(`Compaction summary hit the token cap (${diagnostics})`);
  }
  const summary = contentText(result.content);
  if (summary.trim().length === 0) {
    throw new Error(`Compaction returned an empty summary (${diagnostics})`);
  }
  const compacted: TConversation = {
    ...state,
    summary,
    summaryTimestamp: Date.now(),
    entries: state.entries.slice(cut),
    summarizedThroughId: state.entries[cut - 1]?.id ?? state.summarizedThroughId,
  };
  // Old assistant usage describes the pre-compaction request; do not reuse it.
  const tokensAfter =
    fixedTokens +
    conversationMessages(compacted).reduce((sum, message) => sum + estimateTokens(message), 0);
  if (!force && tokensAfter >= tokensBefore) {
    throw new Error("Compaction did not reduce context");
  }
  return { state: compacted, usage: result.usage, tokensBefore, tokensAfter };
}
