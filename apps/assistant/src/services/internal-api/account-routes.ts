import { EEventType } from "@bellaclaw/database";
import {
  SGatewayActivationCheckRequest,
  SGatewayLinkRequest,
  SGatewayPresence,
  type TGatewayAccount,
  type TGatewayActivationCheck,
  type TGatewayChatLink,
  type TGatewayLinkStarted,
  type TGatewayPresenceAccepted,
} from "@bellaclaw/shared";
import { AppChannel } from "../app";
import { AppStream } from "../app-stream";
import { AuthorizationService } from "../authorization";
import { IdentityService, type TAccountKeys } from "../identity";
import type { TIdentityLink } from "../identity/schema";
import { parseCanonicalChatKey } from "../messaging/chat-key";
import { COMMAND_TIMEOUT_MS, requestOutcome } from "./outcomes";
import { systemTrace } from "./shared";

// NOTE: well under both servers' 255 s idle timeout, so an idle stream stays open
const STREAM_KEEP_ALIVE_MS = 25_000;

// publishes identity.link.requested and answers once the cutover began; it does not wait for
// identity.linked
export async function requestLink(body: unknown): Promise<TGatewayLinkStarted> {
  const request = SGatewayLinkRequest.safeParse(body);

  if (!request.success) {
    throw new Error("Invalid link request");
  }

  const { accountId, chatKey } = request.data;
  const address = parseCanonicalChatKey(chatKey);

  if (address === undefined) {
    throw new Error("Invalid chat key");
  }

  await requestOutcome(
    systemTrace(chatKey),
    chatKey,
    EEventType.IdentityLinkRequested,
    { accountId, channel: address.platform, address: address.chatId },
    EEventType.IdentityLinkStarted,
    () => undefined,
    COMMAND_TIMEOUT_MS,
    "Link request timed out",
  );

  return { state: "migrating" };
}

// The edge's one live stream for every account: each event of the app stream as a line of JSON,
// and an empty line as a keep-alive. Closing the connection releases the listener and the timer,
// and ends the presence the edge reported while it was open
export function openStream(request: Request): Response {
  const encoder = new TextEncoder();
  let release = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = AppStream.instance.listen((event) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      });
      const endPresence = AppChannel.instance.openEdgeConnection();
      const keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode("\n"));
      }, STREAM_KEEP_ALIVE_MS);
      release = () => {
        clearInterval(keepAlive);
        close();
        endPresence();
      };
      request.signal.addEventListener("abort", release, { once: true });
      // the first line sends the response's headers, so the edge sees the stream open at once
      controller.enqueue(encoder.encode("\n"));
    },
    cancel() {
      release();
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}

// a read: checking a code changes nothing, so no command is published
export async function handleActivationCheck(request: Request): Promise<Response> {
  const check = SGatewayActivationCheckRequest.safeParse(await request.json());

  if (!check.success) {
    throw new Error("Invalid activation code check");
  }

  const matches = AuthorizationService.instance.matchesActivationToken(check.data.code);
  const body: TGatewayActivationCheck = { result: "unset" };

  if (matches === true) {
    body.result = "valid";
  } else if (matches === false) {
    body.result = "invalid";
  }

  return Response.json(body);
}

export async function handlePresence(request: Request): Promise<Response> {
  const presence = SGatewayPresence.safeParse(await request.json());

  if (!presence.success) {
    throw new Error("Invalid presence");
  }

  AppChannel.instance.reportPresence(presence.data.accountIds);
  const body: TGatewayPresenceAccepted = { ok: true };

  return Response.json(body);
}

export async function handleChatLink(chatKey: string): Promise<Response> {
  const link = await IdentityService.instance.link(chatKey);
  const body: TGatewayChatLink = { link: undefined };

  if (link !== undefined) {
    body.link = { accountId: link.accountId, state: link.state };
  }

  return Response.json(body);
}

export function handleAccount(account: TAccountKeys & { links: TIdentityLink[] }): Response {
  const body: TGatewayAccount = {
    conversationKey: account.conversationKey,
    ownerKey: account.ownerKey,
    links: account.links.map((link) => ({
      chatKey: IdentityService.instance.addressKey(link),
      state: link.state,
      linkedAt: link.linkedAt.getTime(),
    })),
  };

  return Response.json(body);
}
