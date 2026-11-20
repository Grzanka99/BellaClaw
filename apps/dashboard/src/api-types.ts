// The JSON shapes of the dashboard's HTTP API, for the browser. Types only: import with
// `import type`, so no server code reaches the client bundle.
import type { THistoryMessage, TListedConversation } from "@bellaclaw/database";
import type {
  TDashboardConversationCreated,
  TDashboardConversationDeleted,
  TDashboardLinkState,
  TDashboardMedia,
  TDashboardMessageDeleted,
} from "@bellaclaw/shared";

// a row the app shows: a message, or a display row (a command with its reply, a notice, a failure
// reply). channel: where it came in or went out; clientMessageId: the id the app gave a message it
// sent; createdAt: epoch ms; images: a user message's images, absent when it has none, each
// downloadable by its mediaId or a placeholder without one
export type { THistoryMessage } from "@bellaclaw/database";
// POST /api/conversations/:conversationKey/messages body and answer; model: a plain chat's model;
// images: what uploads to the conversation answered
// GET and PUT /api/personality answer, and PUT /api/personality body (the fields to change, at
// least one): Bella's persona and the persona of the plain chats
export type {
  TDashboardAppMessage,
  TDashboardAppMessageAccepted,
  TDashboardHistoryImage,
  TDashboardModelChoice,
  TDashboardModelState,
  TDashboardModelUpdate,
  TDashboardPersonality,
  TDashboardPersonalityUpdate,
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

// revision: raised on every change of the conversation's transcript; rewriteRevision: the revision
// of its latest change that was not an append. A client synced at or above rewriteRevision fetches
// the rows after its newest by cursor; one below it reloads
export type TConversationRevision = { revision: number; rewriteRevision: number };

// kind bella: the account's Bella conversation; plain: a plain chat. title: a plain chat's, absent
// until one is written; createdAt: when a plain chat was created, epoch ms; lastMessage: the
// newest row the app shows, absent while there is none
export type TConversationSummary = TListedConversation;

// GET /api/conversations answer: the account's Bella conversation first, then its plain chats, the
// latest active first (by their newest row, else their creation)
export type TConversationsResponse = { conversations: TConversationSummary[] };

// POST /api/conversations answer: a new plain chat, listed and empty, at revision 0
export type TConversationCreatedResponse = TDashboardConversationCreated;

// POST /api/conversations/:conversationKey/media answer: the uploaded image, as a send names it.
// The body is the image's bytes, Content-Type its type
export type TMediaUploadedResponse = TDashboardMedia;

// DELETE /api/conversations/:conversationKey answer: the plain chat is gone with its history
export type TConversationDeletedResponse = TDashboardConversationDeleted;

// GET /api/conversations/:conversationKey/messages answer, oldest first: the newest rows, the rows
// below `before`, or the rows above `after`. nextBefore: the `before` of the older page, when one
// exists; nextAfter: the `after` of the next newer page, when the rows above `after` fill more
// than one page. The revisions are read before the rows, so rows may be newer than them, never
// older
export type THistoryResponse = TConversationRevision & {
  messages: THistoryMessage[];
  nextBefore?: number;
  nextAfter?: number;
};

// GET /api/stream server-sent events, data as JSON, each of the signed-in account only. check:
// compare revisions now, sent on connect and whenever the edge's stream to the assistant opens or
// drops, and stop showing typing; changed: the conversation's transcript changed; typing: a turn of
// the conversation started (true) or ended (false); deleted: the plain chat is gone. A client that
// missed a delete finds the chat gone from the list
export type TAppStreamEvent =
  | { type: "check" }
  | ({ type: "changed"; conversationKey: string } & TConversationRevision)
  | { type: "typing"; conversationKey: string; typing: boolean }
  | { type: "deleted"; conversationKey: string };

// createdAt: epoch ms
export type TFactNode = { id: number; text: string; createdAt: number };

// source and target are fact ids, source < target
export type TFactLink = { source: number; target: number };

// GET /api/facts answer: the account's facts
export type TFactsResponse = { nodes: TFactNode[]; links: TFactLink[] };
