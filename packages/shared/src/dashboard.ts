import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { TOption } from "./option";

export const DASHBOARD_LINK_TOKEN_TTL_MS = 10 * 60 * 1000;

const SDashboardLinkToken = z
  .object({ chatId: z.string().min(1), nonce: z.string().min(1), expiresAt: z.number().int() })
  .strict();

export type TDashboardLinkToken = z.infer<typeof SDashboardLinkToken>;

function signDashboardLinkPayload(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

// now: epoch ms
export function createDashboardLinkToken(secret: string, chatId: string, now: number): string {
  const token: TDashboardLinkToken = {
    chatId,
    nonce: randomBytes(16).toString("base64url"),
    expiresAt: now + DASHBOARD_LINK_TOKEN_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(token)).toString("base64url");

  return `${payload}.${signDashboardLinkPayload(secret, payload).toString("base64url")}`;
}

// now: epoch ms. Undefined for a malformed, tampered or expired token.
export function verifyDashboardLinkToken(
  secret: string,
  token: string,
  now: number,
): TOption<TDashboardLinkToken> {
  const [payload, signature, ...rest] = token.split(".");

  if (payload === undefined || signature === undefined || rest.length > 0) {
    return undefined;
  }

  const expected = signDashboardLinkPayload(secret, payload);
  const actual = Buffer.from(signature, "base64url");

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return undefined;
  }

  let decoded: unknown;

  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return undefined;
  }

  const parsed = SDashboardLinkToken.safeParse(decoded);

  if (!parsed.success || parsed.data.expiresAt <= now) {
    return undefined;
  }

  return parsed.data;
}

export const SDashboardReasoningEffort = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type TDashboardReasoningEffort = z.infer<typeof SDashboardReasoningEffort>;

// "default" is no tier
export const SDashboardServiceTier = z.enum(["default", "flex", "priority"]);

export type TDashboardServiceTier = z.infer<typeof SDashboardServiceTier>;

// GET and PUT /internal/accounts/:accountId/model response
export const SDashboardModelState = z.object({
  provider: z.string(),
  providers: z.array(z.string()),
  // one entry per model purpose, with the effective selection
  purposes: z.array(
    z.object({
      purpose: z.string(),
      model: z.string(),
      // "default" is the model's own default
      effort: z.union([SDashboardReasoningEffort, z.literal("default")]),
      serviceTier: SDashboardServiceTier,
    }),
  ),
  // the models of the active provider
  availableModels: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      supportedEfforts: z.array(SDashboardReasoningEffort),
      supportsServiceTier: z.boolean(),
    }),
  ),
});

export type TDashboardModelState = z.infer<typeof SDashboardModelState>;

// PUT /internal/accounts/:accountId/model body: the AI arguments of the update-settings tool.
// aiProvider is one of `providers` and aiModelPurpose one of `purposes[].purpose`.
export const SDashboardModelUpdate = z
  .object({
    aiProvider: z.string().min(1).optional(),
    aiModel: z.string().min(1).optional(),
    // Main when omitted
    aiModelPurpose: z.string().min(1).optional(),
    aiReasoningEffort: SDashboardReasoningEffort.optional(),
    aiServiceTier: SDashboardServiceTier.optional(),
    resetAiModel: z.boolean().optional(),
    resetAiReasoningEffort: z.boolean().optional(),
  })
  .strict();

export type TDashboardModelUpdate = z.infer<typeof SDashboardModelUpdate>;

// DELETE /internal/accounts/:accountId/messages/:messageId response
export const SDashboardMessageDeleted = z.object({ deletedMessageIds: z.array(z.number().int()) });

export type TDashboardMessageDeleted = z.infer<typeof SDashboardMessageDeleted>;

// the model a plain chat's turn runs on, which the app keeps per chat. provider: one of the model
// state's `providers`; model: one of that provider's models; effort: one the model supports
export const SDashboardModelChoice = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    effort: SDashboardReasoningEffort,
  })
  .strict();

export type TDashboardModelChoice = z.infer<typeof SDashboardModelChoice>;

// POST /internal/accounts/:accountId/conversations/:conversationKey/messages body: a message the
// app sends. clientMessageId: the app's id of the message; a second send with the same id in the
// same conversation is the same message. model: required for a plain chat, refused for the Bella
// conversation, which runs on the account's settings
export const SDashboardAppMessage = z
  .object({
    clientMessageId: z.string().min(1).max(128),
    text: z.string().refine((text) => text.trim().length > 0, "The message is empty"),
    model: SDashboardModelChoice.optional(),
  })
  .strict();

export type TDashboardAppMessage = z.infer<typeof SDashboardAppMessage>;

// POST /internal/accounts/:accountId/conversations/:conversationKey/messages response: the message
// is stored and its turn will run
export const SDashboardAppMessageAccepted = z.object({ clientMessageId: z.string() });

export type TDashboardAppMessageAccepted = z.infer<typeof SDashboardAppMessageAccepted>;

// POST /internal/accounts/:accountId/conversations response: the new plain chat, listed and
// empty. createdAt: epoch ms
export const SDashboardConversationCreated = z.object({
  conversationKey: z.string(),
  createdAt: z.number().int(),
});

export type TDashboardConversationCreated = z.infer<typeof SDashboardConversationCreated>;

// DELETE /internal/accounts/:accountId/conversations/:conversationKey response: the plain chat is
// gone with its transcript
export const SDashboardConversationDeleted = z.object({ conversationKey: z.string() });

export type TDashboardConversationDeleted = z.infer<typeof SDashboardConversationDeleted>;

// the rejection code of a delete of a conversation that is no plain chat of the account
export const CONVERSATION_NOT_FOUND = "conversation-not-found";

// the rejection code of a link request for an address another account owns
export const ADDRESS_LINKED_ELSEWHERE = "address-linked-elsewhere";

export const SDashboardLinkState = z.enum(["migrating", "active"]);

export type TDashboardLinkState = z.infer<typeof SDashboardLinkState>;

// POST /internal/links body. accountId: the account's public id; chatKey: the address, as a link
// token carries it
export const SDashboardLinkRequest = z
  .object({ accountId: z.string().min(1), chatKey: z.string().min(1) })
  .strict();

export type TDashboardLinkRequest = z.infer<typeof SDashboardLinkRequest>;

// POST /internal/links response: the link is recorded as migrating and its cutover began
export const SDashboardLinkStarted = z.object({ state: z.literal("migrating") });

export type TDashboardLinkStarted = z.infer<typeof SDashboardLinkStarted>;

// GET /internal/links/:chatKey response; no link when the address has none
export const SDashboardChatLink = z.object({
  link: z.object({ accountId: z.string(), state: SDashboardLinkState }).optional(),
});

export type TDashboardChatLink = z.infer<typeof SDashboardChatLink>;

// GET /internal/accounts/:accountId response. conversationKey: the account's Bella conversation,
// the key of its messages; ownerKey: the key of its facts and settings. links: oldest first,
// linkedAt in epoch ms
export const SDashboardAccount = z.object({
  conversationKey: z.string(),
  ownerKey: z.string(),
  links: z.array(
    z.object({ chatKey: z.string(), state: SDashboardLinkState, linkedAt: z.number().int() }),
  ),
});

export type TDashboardAccount = z.infer<typeof SDashboardAccount>;

// body of a 400 (invalid input or rejected command), 401 (bad or missing bearer) or 404 (unknown
// route, or a conversation the account does not own). code: the stable error code of a rejected
// command that has one
export const SDashboardError = z.object({ error: z.string(), code: z.string().optional() });

export type TDashboardError = z.infer<typeof SDashboardError>;

// POST /internal/activation-code/check body: a code a person typed to register
export const SDashboardActivationCheckRequest = z.object({ code: z.string() }).strict();

export type TDashboardActivationCheckRequest = z.infer<typeof SDashboardActivationCheckRequest>;

// POST /internal/activation-code/check response. unset: no activation code is configured, so no
// code is right
export const SDashboardActivationCheck = z.object({
  result: z.enum(["valid", "invalid", "unset"]),
});

export type TDashboardActivationCheck = z.infer<typeof SDashboardActivationCheck>;

// GET /internal/stream: one line of JSON per event, for every account, live from the assistant;
// an empty line keeps an idle connection open. accountId: the account the event belongs to.
// changed: the conversation's transcript changed, with its revisions; typing: a turn of the
// conversation started (true) or ended (false); deleted: the plain chat is gone. Nothing replays
export const SDashboardStreamEvent = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("changed"),
      accountId: z.string(),
      conversationKey: z.string(),
      revision: z.number().int(),
      rewriteRevision: z.number().int(),
    })
    .strict(),
  z
    .object({
      type: z.literal("typing"),
      accountId: z.string(),
      conversationKey: z.string(),
      typing: z.boolean(),
    })
    .strict(),
  z
    .object({ type: z.literal("deleted"), accountId: z.string(), conversationKey: z.string() })
    .strict(),
]);

export type TDashboardStreamEvent = z.infer<typeof SDashboardStreamEvent>;

export const DASHBOARD_STREAM_PATH = "/internal/stream";

export const DASHBOARD_ACTIVATION_CHECK_PATH = "/internal/activation-code/check";

export const DASHBOARD_LINKS_PATH = "/internal/links";

export function dashboardChatLinkPath(chatKey: string): string {
  return `${DASHBOARD_LINKS_PATH}/${encodeURIComponent(chatKey)}`;
}

export function dashboardAccountPath(accountId: string): string {
  return `/internal/accounts/${encodeURIComponent(accountId)}`;
}

export function dashboardAccountModelPath(accountId: string): string {
  return `${dashboardAccountPath(accountId)}/model`;
}

export function dashboardAccountMessagePath(accountId: string, messageId: number): string {
  return `${dashboardAccountPath(accountId)}/messages/${messageId}`;
}

export function dashboardAccountConversationsPath(accountId: string): string {
  return `${dashboardAccountPath(accountId)}/conversations`;
}

export function dashboardAccountConversationPath(
  accountId: string,
  conversationKey: string,
): string {
  return `${dashboardAccountConversationsPath(accountId)}/${encodeURIComponent(conversationKey)}`;
}

export function dashboardAccountConversationMessagesPath(
  accountId: string,
  conversationKey: string,
): string {
  return `${dashboardAccountPath(accountId)}/conversations/${encodeURIComponent(conversationKey)}/messages`;
}
