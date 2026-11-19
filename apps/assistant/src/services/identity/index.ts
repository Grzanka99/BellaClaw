import { identityLinksTable } from "@bellaclaw/database";
import type { TOption } from "@bellaclaw/shared";
import { z } from "zod";
import { DatabaseConnector } from "../database";
import { createCanonicalChatKey, parseCanonicalChatKey } from "../messaging/chat-key";
import type { EMessagePlatform } from "../messaging/types";
import { EIdentityLinkState, SIdentityLink, type TIdentityLink } from "./schema";

const ACCOUNT_OWNER_PREFIX = "account:";
const BELLA_CONVERSATION_PREFIX = "bella:";

export type TChatAddress = {
  channel: EMessagePlatform;
  address: string;
};

// destination: where a message of the conversation goes when it answers no inbound message
export type TResolvedChat = {
  conversationKey: string;
  ownerKey: string;
  destination: TChatAddress;
};

export class IdentityService {
  private static _instance: TOption<IdentityService>;
  private database = DatabaseConnector.instance;
  // by the chat key of the linked address
  private links = new Map<string, TIdentityLink>();
  private loadPromise: TOption<Promise<void>>;

  private constructor() {}

  public static get instance() {
    if (!IdentityService._instance) {
      IdentityService._instance = new IdentityService();
    }

    return IdentityService._instance;
  }

  public setup(): Promise<void> {
    return this.load();
  }

  // NOTE: the one place that builds and reads account keys and turns a chat key into an address.
  // key: an account's owner key or Bella conversation key, or a chat key. An address with an
  // active link means the account's Bella conversation; any other chat key means its own chat
  public async resolve(key: string): Promise<TOption<TResolvedChat>> {
    await this.load();
    let accountId: TOption<string>;

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
      // links of the same instant order by address key
      const first = this.activeLinks()
        .filter((link) => link.accountId === accountId)
        .sort((left, right) => {
          const byTime = left.linkedAt.getTime() - right.linkedAt.getTime();
          if (byTime !== 0) {
            return byTime;
          }

          return this.addressKey(left).localeCompare(this.addressKey(right));
        })[0];

      if (first === undefined) {
        return undefined;
      }

      return {
        conversationKey: `${BELLA_CONVERSATION_PREFIX}${accountId}`,
        ownerKey: `${ACCOUNT_OWNER_PREFIX}${accountId}`,
        destination: { channel: first.channel, address: first.address },
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
