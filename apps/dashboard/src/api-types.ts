// The JSON shapes of the dashboard's HTTP API, for the browser. Types only: import with
// `import type`, so no server code reaches the client bundle.
import type { TDashboardMessageDeleted } from "@bellaclaw/shared";

export type {
  TDashboardModelState,
  TDashboardModelUpdate,
  TDashboardReasoningEffort,
  TDashboardServiceTier,
} from "@bellaclaw/shared";

// body of every answer outside 2xx
export type TApiError = { error: string };

// POST /api/link/check and POST /api/link body
export type TLinkRequest = { token: string };

// POST /api/link/check answer
export type TLinkCheckResponse = { valid: boolean };

// POST /api/register body
export type TRegisterRequest = { token: string; username: string; password: string };

// POST /api/login body; a token is redeemed with the login
export type TLoginRequest = { username: string; password: string; token?: string };

// linkedAt: epoch ms
export type TLinkedChat = { chatId: string; linkedAt: number };

// GET /api/me answer, and the answer of register, login and link. chats: latest link first
export type TMeResponse = { username: string; chats: TLinkedChat[] };

// POST /api/logout answer
export type TLogoutResponse = { ok: true };

// createdAt: epoch ms
export type TChatMessage = {
  id: number;
  author: "user" | "assistant";
  text: string;
  createdAt: number;
};

// GET /api/chats/:chatId/messages answer, newest first. nextBefore is the `before` of the next
// page, absent on the last one
export type TMessagesResponse = { messages: TChatMessage[]; nextBefore?: number };

// DELETE /api/chats/:chatId/messages/:messageId answer
export type TMessageDeletedResponse = TDashboardMessageDeleted;

// createdAt: epoch ms
export type TFactNode = { id: number; text: string; createdAt: number };

// source and target are fact ids, source < target
export type TFactLink = { source: number; target: number };

// GET /api/chats/:chatId/facts answer
export type TFactsResponse = { nodes: TFactNode[]; links: TFactLink[] };
