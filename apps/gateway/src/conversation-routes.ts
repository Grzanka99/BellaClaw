import type { THistoryCursor, TOwnedConversation } from "@bellaclaw/database";
import {
  SGatewayAppMessage,
  SGatewayListsUpdate,
  SGatewayModelUpdate,
  SGatewayPersonalityUpdate,
  type TOption,
} from "@bellaclaw/shared";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type {
  TApiError,
  TConversationDeletedResponse,
  TConversationsResponse,
  THistoryResponse,
  TListsResponse,
  TMediaUploadedResponse,
  TMessagesResponse,
} from "./api-types";
import { buildFactGraph } from "./fact-graph";
import {
  apiFailed,
  createRequireSession,
  invalidBody,
  parseBody,
  respond,
  type TEnv,
  type TGatewayDependencies,
} from "./route-support";

const MESSAGES_PAGE_SIZE = 50;
const SMessageId = z.coerce.number().int().positive();
const SHistoryQuery = z
  .object({ after: SMessageId.optional(), before: SMessageId.optional() })
  .refine(
    (query) => query.after === undefined || query.before === undefined,
    "Send after or before, not both",
  );

// the routes of the signed-in account's data: its messages, facts, lists, conversations and their
// media, and its model and personality settings
export function registerConversationRoutes(
  app: Hono<TEnv>,
  { store, reader, internalApi }: TGatewayDependencies,
) {
  const requireSession = createRequireSession(store);

  // The conversation's revisions when the signed-in account owns it, by the keys the assistant
  // names for the account; else the answer, 404 for a conversation of another account or one that
  // does not exist, alike
  async function findConversation(
    c: Context<TEnv>,
    conversationKey: string,
  ): Promise<Response | TOwnedConversation> {
    const account = await internalApi.getAccount(c.var.account.publicId);

    if ("error" in account) {
      return apiFailed(c, account);
    }

    const owned = await reader.findConversation(conversationKey, account.data);

    if (owned === undefined) {
      return c.json<TApiError>({ error: "Not found" }, 404);
    }

    return owned;
  }

  // NOTE: every account route reaches only the signed-in account's data, by the keys the
  // assistant names for its public id
  app.get("/api/messages", requireSession, async (c) => {
    const before = SMessageId.optional().safeParse(c.req.query("before"));

    if (!before.success) {
      return c.json<TApiError>({ error: "Invalid before" }, 400);
    }

    const account = await internalApi.getAccount(c.var.account.publicId);

    if ("error" in account) {
      return apiFailed(c, account);
    }

    // one row more than a page tells whether another page follows
    const messages = await reader.listMessages(
      account.data.conversationKey,
      before.data,
      MESSAGES_PAGE_SIZE + 1,
    );
    const response: TMessagesResponse = { messages: messages.slice(0, MESSAGES_PAGE_SIZE) };

    if (messages.length > MESSAGES_PAGE_SIZE) {
      response.nextBefore = response.messages.at(-1)?.id;
    }

    return c.json(response);
  });

  app.delete("/api/messages/:messageId", requireSession, async (c) => {
    const messageId = SMessageId.safeParse(c.req.param("messageId"));

    if (!messageId.success) {
      return c.json<TApiError>({ error: "Invalid message id" }, 400);
    }

    return respond(c, await internalApi.deleteMessage(c.var.account.publicId, messageId.data));
  });

  app.get("/api/facts", requireSession, async (c) => {
    const account = await internalApi.getAccount(c.var.account.publicId);

    if ("error" in account) {
      return apiFailed(c, account);
    }

    return c.json(buildFactGraph(await reader.listFacts(account.data.ownerKey)));
  });

  app.get("/api/lists", requireSession, async (c) => {
    const account = await internalApi.getAccount(c.var.account.publicId);

    if ("error" in account) {
      return apiFailed(c, account);
    }

    return c.json<TListsResponse>({
      lists: await reader.listLists(account.data.ownerKey, Date.now()),
    });
  });

  // NOTE: the assistant applies the changes on the account's lane; the answer is the lists read
  // after them, as GET answers
  app.post("/api/lists/changes", requireSession, async (c) => {
    const body = await parseBody(c.req.raw, SGatewayListsUpdate);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    const account = await internalApi.getAccount(c.var.account.publicId);

    if ("error" in account) {
      return apiFailed(c, account);
    }

    const result = await internalApi.updateLists(c.var.account.publicId, body.data);

    if ("error" in result) {
      return apiFailed(c, result);
    }

    return c.json<TListsResponse>({
      lists: await reader.listLists(account.data.ownerKey, Date.now()),
    });
  });

  // NOTE: the conversations of the app. A conversation key from the client is used only after the
  // registry's rule says the signed-in account owns it; any other key is answered like one that
  // does not exist. The assistant checks a send again
  app.get("/api/conversations", requireSession, async (c) => {
    const account = await internalApi.getAccount(c.var.account.publicId);

    if ("error" in account) {
      return apiFailed(c, account);
    }

    return c.json<TConversationsResponse>({
      conversations: await reader.listConversations(account.data),
    });
  });

  // a new plain chat of the signed-in account; the assistant builds its key
  app.post("/api/conversations", requireSession, async (c) =>
    respond(c, await internalApi.createConversation(c.var.account.publicId)),
  );

  // NOTE: only a plain chat is deleted; the assistant answers 404 for the Bella conversation, as
  // for a conversation of another account
  app.delete("/api/conversations/:conversationKey", requireSession, async (c) => {
    const conversationKey = c.req.param("conversationKey");
    const owned = await findConversation(c, conversationKey);

    if (owned instanceof Response) {
      return owned;
    }

    const result = await internalApi.deleteConversation(c.var.account.publicId, conversationKey);

    if ("error" in result) {
      return apiFailed(c, result);
    }

    return c.json<TConversationDeletedResponse>(result.data);
  });

  app.get("/api/conversations/:conversationKey/messages", requireSession, async (c) => {
    const query = SHistoryQuery.safeParse({
      after: c.req.query("after"),
      before: c.req.query("before"),
    });

    if (!query.success) {
      return c.json(invalidBody(query.error), 400);
    }

    const conversationKey = c.req.param("conversationKey");
    // NOTE: the revisions are read before the rows, so a change between the two reads leaves the
    // client behind the rows it got, never ahead of them
    const owned = await findConversation(c, conversationKey);

    if (owned instanceof Response) {
      return owned;
    }

    let cursor: TOption<THistoryCursor>;

    if (query.data.after !== undefined) {
      cursor = { direction: "after", id: query.data.after };
    } else if (query.data.before !== undefined) {
      cursor = { direction: "before", id: query.data.before };
    }

    // one row more than a page tells whether another page follows
    const messages = await reader.listHistory(conversationKey, cursor, MESSAGES_PAGE_SIZE + 1);
    const response: THistoryResponse = { ...owned, messages };

    if (messages.length > MESSAGES_PAGE_SIZE) {
      if (cursor?.direction === "after") {
        response.messages = messages.slice(0, MESSAGES_PAGE_SIZE);
        response.nextAfter = response.messages.at(-1)?.id;
      } else {
        response.messages = messages.slice(1);
        response.nextBefore = response.messages[0]?.id;
      }
    }

    return c.json(response);
  });

  app.post("/api/conversations/:conversationKey/messages", requireSession, async (c) => {
    const conversationKey = c.req.param("conversationKey");
    const owned = await findConversation(c, conversationKey);

    if (owned instanceof Response) {
      return owned;
    }

    const body = await parseBody(c.req.raw, SGatewayAppMessage);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    const result = await internalApi.sendMessage(
      c.var.account.publicId,
      conversationKey,
      body.data,
    );

    if ("error" in result) {
      return apiFailed(c, result);
    }

    return c.json(result.data);
  });

  // NOTE: the image's bytes stream on to the assistant, which checks the declared type
  // (Content-Type), the size and the format before it stores anything. The answer names the image
  // for a send to this conversation: 413 for a file over 5 MB, 415 for another type or content
  app.post("/api/conversations/:conversationKey/media", requireSession, async (c) => {
    const conversationKey = c.req.param("conversationKey");
    const owned = await findConversation(c, conversationKey);

    if (owned instanceof Response) {
      return owned;
    }

    const result = await internalApi.uploadMedia(
      c.var.account.publicId,
      conversationKey,
      c.req.header("Content-Type") ?? "",
      c.req.raw.body,
    );

    if ("error" in result) {
      return apiFailed(c, result);
    }

    return c.json<TMediaUploadedResponse>(result.data);
  });

  // the image's bytes: 404 for a conversation that is not the account's, 410 for an image this
  // conversation does not keep
  app.get("/api/conversations/:conversationKey/media/:mediaId", requireSession, async (c) => {
    const conversationKey = c.req.param("conversationKey");
    const owned = await findConversation(c, conversationKey);

    if (owned instanceof Response) {
      return owned;
    }

    const result = await internalApi.downloadMedia(
      c.var.account.publicId,
      conversationKey,
      c.req.param("mediaId"),
    );

    if ("error" in result) {
      return apiFailed(c, result);
    }

    return new Response(result.data.body, {
      headers: {
        "Content-Type": result.data.headers.get("Content-Type") ?? "",
        "Cache-Control": "no-store",
      },
    });
  });

  app.get("/api/model", requireSession, async (c) =>
    respond(c, await internalApi.getModel(c.var.account.publicId)),
  );

  app.put("/api/model", requireSession, async (c) => {
    const body = await parseBody(c.req.raw, SGatewayModelUpdate);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    return respond(c, await internalApi.updateModel(c.var.account.publicId, body.data));
  });

  app.get("/api/models", requireSession, async (c) =>
    respond(c, await internalApi.getModels(c.var.account.publicId)),
  );

  app.get("/api/personality", requireSession, async (c) =>
    respond(c, await internalApi.getPersonality(c.var.account.publicId)),
  );

  app.put("/api/personality", requireSession, async (c) => {
    const body = await parseBody(c.req.raw, SGatewayPersonalityUpdate);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    return respond(c, await internalApi.updatePersonality(c.var.account.publicId, body.data));
  });
}
