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

// GET and PUT /internal/chats/:chatId/model response
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

// PUT /internal/chats/:chatId/model body: the AI arguments of the update-settings tool.
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

// DELETE /internal/chats/:chatId/messages/:messageId response
export const SDashboardMessageDeleted = z.object({ deletedMessageIds: z.array(z.number().int()) });

export type TDashboardMessageDeleted = z.infer<typeof SDashboardMessageDeleted>;

// body of a 400 (invalid input or rejected command), 401 (bad or missing bearer) or 404 (unknown
// route)
export const SDashboardError = z.object({ error: z.string() });

export type TDashboardError = z.infer<typeof SDashboardError>;

export function dashboardChatModelPath(chatId: string): string {
  return `/internal/chats/${encodeURIComponent(chatId)}/model`;
}

export function dashboardChatMessagePath(chatId: string, messageId: number): string {
  return `/internal/chats/${encodeURIComponent(chatId)}/messages/${messageId}`;
}
