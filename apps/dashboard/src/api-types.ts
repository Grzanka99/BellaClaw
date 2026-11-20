// The JSON shapes of the dashboard's HTTP API, for the browser. Types only: import with
// `import type`, so no server code reaches the client bundle.
import type { TDashboardLinkState, TDashboardMessageDeleted } from "@bellaclaw/shared";

export type {
  TDashboardModelState,
  TDashboardModelUpdate,
  TDashboardReasoningEffort,
  TDashboardServiceTier,
} from "@bellaclaw/shared";

// body of every answer outside 2xx. code otherAccount: the session belongs to another account than
// the one the request's account header names
export type TApiError = { error: string; code?: "otherAccount" };

// POST /api/link/check body
export type TLinkRequest = { token: string };

// POST /api/link body; the account header names the signed-in account the confirmation shows
export type TLinkConfirmRequest = { token: string };

// POST /api/link/check answer. chatKey: the link's address. username: present when the address is
// linked already, so the link logs into that account
export type TLinkCheckResponse =
  | { valid: false }
  | { valid: true; chatKey: string; username?: string };

// POST /api/link/login body: a link of a linked chat, and an optional new password
export type TLinkLoginRequest = { token: string; password?: string };

// POST /api/register body: either a link of an unlinked chat (token) or the activation code
export type TRegisterRequest = {
  username: string;
  password: string;
  token?: string;
  activationCode?: string;
};

// POST /api/login body; a token is redeemed with the login
export type TLoginRequest = { username: string; password: string; token?: string };

// chatKey: the linked address; linkedAt: epoch ms
export type TLinkedChat = { chatKey: string; state: TDashboardLinkState; linkedAt: number };

// GET /api/me answer, and the answer of register, login, link login and link. chats: oldest link
// first
export type TMeResponse = { username: string; chats: TLinkedChat[] };

// the answer of register, login and link login to the app (a request with a bearer token or the
// client header "app"): the account and the bearer token of its new session
export type TAppSessionResponse = TMeResponse & { token: string };

// POST /api/logout answer
export type TLogoutResponse = { ok: true };

// createdAt: epoch ms
export type TChatMessage = {
  id: number;
  author: "user" | "assistant";
  text: string;
  createdAt: number;
};

// GET /api/messages answer: the account's Bella conversation, newest first. nextBefore is the `before` of the next
// page, absent on the last one
export type TMessagesResponse = { messages: TChatMessage[]; nextBefore?: number };

// DELETE /api/messages/:messageId answer
export type TMessageDeletedResponse = TDashboardMessageDeleted;

// createdAt: epoch ms
export type TFactNode = { id: number; text: string; createdAt: number };

// source and target are fact ids, source < target
export type TFactLink = { source: number; target: number };

// GET /api/facts answer: the account's facts
export type TFactsResponse = { nodes: TFactNode[]; links: TFactLink[] };
