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
// route). code: the stable error code of a rejected command that has one
export const SDashboardError = z.object({ error: z.string(), code: z.string().optional() });

export type TDashboardError = z.infer<typeof SDashboardError>;

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
