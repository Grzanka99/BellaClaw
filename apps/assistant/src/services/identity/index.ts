import { EEventType, identityLinksTable } from "@bellaclaw/database";
import { ADDRESS_LINKED_ELSEWHERE, type TOption } from "@bellaclaw/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { DatabaseConnector } from "../database";
import { ESubscriptionMode, EventBus } from "../events";
import { ERejectionCode, type TIdentityLinkKeys } from "../events/catalog";
import { createCanonicalChatKey, parseCanonicalChatKey } from "../messaging/chat-key";
import { EMessagePlatform } from "../messaging/types";
import {
  EIdentityLinkOwner,
  EIdentityLinkState,
  SIdentityLink,
  type TIdentityLink,
} from "./schema";

const ACCOUNT_OWNER_PREFIX = "account:";
const BELLA_CONVERSATION_PREFIX = "bella:";
// plain:<accountId>:<id>, a plain chat of the account
const PLAIN_CONVERSATION_PREFIX = "plain:";
// how long after its arrival a message or a cron fire waits for a link of its key to complete
const LINK_HOLD_MS = 10 * 60_000;

export type TChatAddress = {
  channel: EMessagePlatform;
  address: string;
};

// destination: where a message of the conversation goes when it answers no inbound message, unless
// the account has a registered device: Outbound then sends it to the app
export type TResolvedChat = {
  conversationKey: string;
  ownerKey: string;
  destination: TChatAddress;
};

// the account's Bella conversation and owner key
export type TAccountKeys = {
  conversationKey: string;
  ownerKey: string;
};

export class IdentityService {
  private static _instance: TOption<IdentityService>;
  private database = DatabaseConnector.instance;
  // by the chat key of the linked address
  private links = new Map<string, TIdentityLink>();
  private loadPromise: TOption<Promise<void>>;
  // re-checked on every change of the read model
  private linkWaiters = new Set<() => void>();
  private linkHoldMs = LINK_HOLD_MS;

  private constructor() {}

  public static get instance() {
    if (!IdentityService._instance) {
      IdentityService._instance = new IdentityService();
    }

    return IdentityService._instance;
  }

  // NOTE: the read model has its own live consumer, so its update never waits behind a command or
  // a move on Identity's lanes
  public setup(): Promise<void> {
    const bus = EventBus.instance;

    bus.subscribe({
      consumer: "identity",
      type: EEventType.IdentityLinkRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        const { accountId, channel, address } = event.payload;
        const chatKey = this.addressKey({ channel, address });
        const keys: TIdentityLinkKeys = {
          accountId,
          channel,
          address,
          chatKey,
          conversationKey: `${BELLA_CONVERSATION_PREFIX}${accountId}`,
          ownerKey: `${ACCOUNT_OWNER_PREFIX}${accountId}`,
        };

        // NOTE: a repeated request for an active link of the same account leaves the row as it
        // is and starts the moves again; they find nothing left to move
        await ctx.complete(async (tx, emit) => {
          const existing = await tx
            .select({ accountId: identityLinksTable.accountId, state: identityLinksTable.state })
            .from(identityLinksTable)
            .where(
              and(eq(identityLinksTable.channel, channel), eq(identityLinksTable.address, address)),
            )
            .get();

          if (existing !== undefined && existing.accountId !== accountId) {
            emit(
              EEventType.CommandRejected,
              {
                commandType: event.type,
                code: ERejectionCode.Invalid,
                message: "The address is linked to another account",
                errorCode: ADDRESS_LINKED_ELSEWHERE,
              },
              undefined,
              undefined,
            );
            return;
          }

          // one cutover of an address at a time: a second would distill its transcript again
          if (existing?.state === EIdentityLinkState.Migrating) {
            emit(
              EEventType.CommandRejected,
              {
                commandType: event.type,
                code: ERejectionCode.Invalid,
                message: "The address is already being linked",
              },
              undefined,
              undefined,
            );
            return;
          }

          if (existing === undefined) {
            await tx.insert(identityLinksTable).values({
              channel,
              address,
              accountId,
              state: EIdentityLinkState.Migrating,
              linkedAt: new Date(),
            });
          }

          // on the address's lanes, where Conversation's barrier waits behind the address's turns
          emit(EEventType.IdentityLinkStarted, keys, undefined, chatKey);
        });
      },
    });
    bus.subscribe({
      consumer: "identity",
      type: EEventType.IdentityLinkMoved,
      mode: ESubscriptionMode.Durable,
      backoffMs: [1_000, 5_000],
      handler: async (event, ctx) => {
        const { owner, ...keys } = event.payload;

        await ctx.complete(async (tx, emit) => {
          const where = and(
            eq(identityLinksTable.channel, keys.channel),
            eq(identityLinksTable.address, keys.address),
          );
          const row = await tx.select().from(identityLinksTable).where(where).get();

          if (row === undefined) {
            throw new Error("identity.link.moved for an address with no link");
          }

          if (row.state === EIdentityLinkState.Active) {
            return;
          }

          const movedOwners = [...new Set([...row.movedOwners, owner])];

          if (!Object.values(EIdentityLinkOwner).every((name) => movedOwners.includes(name))) {
            await tx.update(identityLinksTable).set({ movedOwners }).where(where);
            return;
          }

          const linkedAt = new Date();
          await tx
            .update(identityLinksTable)
            .set({ state: EIdentityLinkState.Active, linkedAt, movedOwners })
            .where(where);
          emit(
            EEventType.IdentityLinked,
            { ...keys, linkedAt: linkedAt.getTime() },
            undefined,
            undefined,
          );
        });
      },
    });
    bus.subscribe({
      consumer: "identity-cache",
      type: EEventType.IdentityLinkStarted,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: async (event) => {
        const { chatKey, channel, address, accountId } = event.payload;

        // a repeated request does not take an active link back
        if (this.links.get(chatKey)?.state !== EIdentityLinkState.Active) {
          this.links.set(chatKey, {
            channel,
            address,
            accountId,
            state: EIdentityLinkState.Migrating,
            linkedAt: new Date(event.occurredAt),
          });
        }

        this.notifyLinkWaiters();
      },
    });
    bus.subscribe({
      consumer: "identity-cache",
      type: EEventType.IdentityLinked,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: async (event) => {
        const { chatKey, channel, address, accountId, linkedAt } = event.payload;

        this.links.set(chatKey, {
          channel,
          address,
          accountId,
          state: EIdentityLinkState.Active,
          linkedAt: new Date(linkedAt),
        });
        this.notifyLinkWaiters();
      },
    });

    return this.load();
  }

  // NOTE: the one place that builds and reads account keys and turns a chat key into an address.
  // key: an account's owner key or Bella conversation key, a plain chat's key, or a chat key. An
  // address with an active link means the account's Bella conversation; any other chat key means
  // its own chat. An account's destination is its oldest active link, else the link being made,
  // else the app. A plain chat is its own conversation, of the app only
  public async resolve(key: string): Promise<TOption<TResolvedChat>> {
    await this.load();
    let accountId: TOption<string>;

    if (key.startsWith(PLAIN_CONVERSATION_PREFIX)) {
      accountId = key.slice(PLAIN_CONVERSATION_PREFIX.length, key.lastIndexOf(":"));

      return {
        conversationKey: key,
        ownerKey: `${ACCOUNT_OWNER_PREFIX}${accountId}`,
        destination: { channel: EMessagePlatform.App, address: accountId },
      };
    }

    if (key.startsWith(ACCOUNT_OWNER_PREFIX)) {
      accountId = key.slice(ACCOUNT_OWNER_PREFIX.length);
    } else if (key.startsWith(BELLA_CONVERSATION_PREFIX)) {
      accountId = key.slice(BELLA_CONVERSATION_PREFIX.length);
    } else {
      const link = this.links.get(key);

      if (link?.state === EIdentityLinkState.Active) {
        accountId = link.accountId;
      }
    }

    if (accountId !== undefined) {
      const links = [...this.links.values()].filter((link) => link.accountId === accountId);
      let candidates = links.filter((link) => link.state === EIdentityLinkState.Active);

      // an account whose first link is still being made is reached at that address
      if (candidates.length === 0) {
        candidates = links;
      }

      // links of the same instant order by address key
      const first = candidates.sort((left, right) => {
        const byTime = left.linkedAt.getTime() - right.linkedAt.getTime();
        if (byTime !== 0) {
          return byTime;
        }

        return this.addressKey(left).localeCompare(this.addressKey(right));
      })[0];

      // NOTE: an account with no link has no main channel yet: its messages go to the app, where
      // the transcript row is the delivery
      let destination: TChatAddress = { channel: EMessagePlatform.App, address: accountId };

      if (first !== undefined) {
        destination = { channel: first.channel, address: first.address };
      }

      return {
        conversationKey: `${BELLA_CONVERSATION_PREFIX}${accountId}`,
        ownerKey: `${ACCOUNT_OWNER_PREFIX}${accountId}`,
        destination,
      };
    }

    const parsed = parseCanonicalChatKey(key);

    if (parsed === undefined) {
      return undefined;
    }

    return {
      conversationKey: key,
      ownerKey: key,
      destination: { channel: parsed.platform, address: parsed.chatId },
    };
  }

  // the account of an address that is linked or being linked; undefined for any other key
  public async linkedAccount(key: string): Promise<TOption<TAccountKeys>> {
    await this.load();
    const link = this.links.get(key);

    if (link === undefined) {
      return undefined;
    }

    return {
      conversationKey: `${BELLA_CONVERSATION_PREFIX}${link.accountId}`,
      ownerKey: `${ACCOUNT_OWNER_PREFIX}${link.accountId}`,
    };
  }

  // the link of an address, by its chat key
  public async link(chatKey: string): Promise<TOption<TIdentityLink>> {
    await this.load();

    return this.links.get(chatKey);
  }

  // the account's keys and the links of its addresses, oldest first
  public async account(accountId: string): Promise<TAccountKeys & { links: TIdentityLink[] }> {
    await this.load();

    return {
      conversationKey: `${BELLA_CONVERSATION_PREFIX}${accountId}`,
      ownerKey: `${ACCOUNT_OWNER_PREFIX}${accountId}`,
      links: [...this.links.values()]
        .filter((link) => link.accountId === accountId)
        .sort((left, right) => left.linkedAt.getTime() - right.linkedAt.getTime()),
    };
  }

  // Resolves true once no link of the key's account is being made, false when the hold that counts
  // from arrivedAt (epoch ms) ends first, so a retry or a restart does not extend it. key: an
  // address's chat key or an account's owner key
  public async waitWhileLinking(key: string, arrivedAt: number): Promise<boolean> {
    await this.load();
    const timeoutMs = arrivedAt + this.linkHoldMs - Date.now();

    if (!this.isLinking(key)) {
      return true;
    }

    if (timeoutMs <= 0) {
      return false;
    }

    const { promise, resolve } = Promise.withResolvers<boolean>();
    const finish = (linked: boolean) => {
      clearTimeout(timer);
      this.linkWaiters.delete(check);
      resolve(linked);
    };
    const check = () => {
      if (!this.isLinking(key)) {
        finish(true);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    this.linkWaiters.add(check);

    return promise;
  }

  // the account id of an account's owner key; undefined for an address's own key
  public accountIdOf(ownerKey: string): TOption<string> {
    if (!ownerKey.startsWith(ACCOUNT_OWNER_PREFIX)) {
      return undefined;
    }

    return ownerKey.slice(ACCOUNT_OWNER_PREFIX.length);
  }

  // a new plain chat's key, unique to it; ownerKey: an account's owner key
  public plainConversationKey(ownerKey: string): string {
    const accountId = this.accountIdOf(ownerKey);

    if (accountId === undefined) {
      throw new Error(`Unknown owner key ${ownerKey}`);
    }

    return `${PLAIN_CONVERSATION_PREFIX}${accountId}:${crypto.randomUUID()}`;
  }

  // whether the key is a plain chat's, listed or deleted
  public isPlainConversation(key: string): boolean {
    return key.startsWith(PLAIN_CONVERSATION_PREFIX);
  }

  // the chat key of an address
  public addressKey(address: TChatAddress): string {
    return createCanonicalChatKey(address.channel, address.address);
  }

  // the Bella conversation of every account with an active link, then every authorized chat
  // whose address has none
  public async listNoticeRecipients(authorizedChatIds: string[]): Promise<string[]> {
    await this.load();
    const accounts = new Set(this.activeLinks().map((link) => link.accountId));
    const recipients = [...accounts].map((accountId) => `${BELLA_CONVERSATION_PREFIX}${accountId}`);

    for (const chatId of authorizedChatIds) {
      if (this.links.get(chatId)?.state !== EIdentityLinkState.Active) {
        recipients.push(chatId);
      }
    }

    return recipients;
  }

  private isLinking(key: string): boolean {
    let accountId = this.links.get(key)?.accountId;

    if (key.startsWith(ACCOUNT_OWNER_PREFIX)) {
      accountId = key.slice(ACCOUNT_OWNER_PREFIX.length);
    }

    return [...this.links.values()].some(
      (link) => link.accountId === accountId && link.state === EIdentityLinkState.Migrating,
    );
  }

  private notifyLinkWaiters(): void {
    for (const check of [...this.linkWaiters]) {
      check();
    }
  }

  private activeLinks(): TIdentityLink[] {
    return [...this.links.values()].filter((link) => link.state === EIdentityLinkState.Active);
  }

  private load(): Promise<void> {
    if (this.loadPromise === undefined) {
      this.loadPromise = this.loadLinks();
    }

    return this.loadPromise;
  }

  private async loadLinks(): Promise<void> {
    const rows = await this.database.run(async (db) => {
      return db.select().from(identityLinksTable);
    });
    const parsed = z.array(SIdentityLink).safeParse(rows);

    if (!parsed.success) {
      throw new Error(`Invalid identity links in database: ${parsed.error.message}`);
    }

    for (const link of parsed.data) {
      this.links.set(this.addressKey(link), link);
    }
  }
}
