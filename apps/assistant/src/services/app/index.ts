import { rm } from "node:fs/promises";
import { join } from "node:path";
import { appMediaTable, EEventType, findOwnedConversation } from "@bellaclaw/database";
import {
  createLogger,
  repositoryPath,
  type TDashboardMedia,
  type TLogger,
  type TOption,
} from "@bellaclaw/shared";
import type { BunFile } from "bun";
import { and, eq, inArray } from "drizzle-orm";
import { DatabaseConnector, type TDatabaseHandle } from "../database";
import { ESubscriptionMode, EventBus } from "../events";
import type { TAccountKeys } from "../identity";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform, type TAttachmentRef, type TAttachmentStore } from "../messaging/types";

// The supported image type the bytes really are, by their leading bytes; undefined for any other
// content
export function imageTypeOf(data: Uint8Array): TOption<string> {
  const head = Buffer.from(data.subarray(0, 12)).toString("latin1");

  if (head.startsWith("\xff\xd8\xff")) {
    return "image/jpeg";
  }

  if (head.startsWith("\x89PNG\r\n\x1a\n")) {
    return "image/png";
  }

  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) {
    return "image/gif";
  }

  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") {
    return "image/webp";
  }

  return undefined;
}

// NOTE: the App channel: the images the app uploads, kept on the assistant's data volume, one
// file per id, listed in app_media. It is the app's attachment store; the app has nothing to send
export class AppChannel implements TAttachmentStore {
  private static _instance: TOption<AppChannel>;
  private logger: TLogger = createLogger("APP");
  public readonly platform = EMessagePlatform.App;

  private constructor() {}

  public static get instance() {
    if (!AppChannel._instance) {
      AppChannel._instance = new AppChannel();
    }

    return AppChannel._instance;
  }

  // read at each use, so a test can point it elsewhere
  private get directory(): string {
    return Bun.env.BELLACLAW_APP_MEDIA_DIR?.trim() || repositoryPath(".data", "app-media");
  }

  public setup(): void {
    MessagingAdapter.instance.registerAttachmentStore(this);

    // a deleted plain chat leaves no image behind, sent or only uploaded
    EventBus.instance.subscribe({
      consumer: "app",
      type: EEventType.ConversationDeleted,
      mode: ESubscriptionMode.Durable,
      backoffMs: [5_000, 30_000],
      handler: async (event) => {
        const { conversationKey } = event.payload;
        const rows = await DatabaseConnector.instance.run((db) =>
          db.select().from(appMediaTable).where(eq(appMediaTable.conversationKey, conversationKey)),
        );

        for (const row of rows) {
          await this.deleteAttachment({
            id: row.id,
            mimeType: row.mimeType,
            channel: EMessagePlatform.App,
            sourceAddress: row.accountId,
          });
        }

        this.logger.info(`Deleted ${rows.length} images of ${conversationKey}`);
      },
    });
  }

  // NOTE: the file is written before its row, so a listed image has its bytes. Check the bytes
  // first: this stores what it is given. The conversation is checked again with the insert, on the
  // database's one queue, so a plain chat deleted while the body was read keeps no image; undefined
  // then
  public async store(
    accountId: string,
    account: TAccountKeys,
    conversationKey: string,
    mimeType: string,
    data: Uint8Array,
  ): Promise<TOption<TDashboardMedia>> {
    const id = crypto.randomUUID();
    await Bun.write(join(this.directory, id), data);
    const stored = await DatabaseConnector.instance.run(async (db) => {
      if ((await findOwnedConversation(db, conversationKey, account)) === undefined) {
        return false;
      }

      await db.insert(appMediaTable).values({
        id,
        accountId,
        conversationKey,
        mimeType,
        createdAt: new Date(),
      });
      return true;
    });

    if (!stored) {
      await rm(join(this.directory, id), { force: true });
      return undefined;
    }

    return { id, mimeType };
  }

  // The images among media that the account uploaded to the conversation, as a message's
  // attachments; one named with another id, conversation or type is left out
  public async findAttachments(
    db: TDatabaseHandle,
    accountId: string,
    conversationKey: string,
    media: TDashboardMedia[],
  ): Promise<TAttachmentRef[]> {
    if (media.length === 0) {
      return [];
    }

    const rows = await db
      .select()
      .from(appMediaTable)
      .where(
        and(
          inArray(
            appMediaTable.id,
            media.map((image) => image.id),
          ),
          eq(appMediaTable.accountId, accountId),
          eq(appMediaTable.conversationKey, conversationKey),
        ),
      );
    const refs: TAttachmentRef[] = [];

    for (const image of media) {
      const row = rows.find((candidate) => candidate.id === image.id);

      if (row !== undefined && row.mimeType === image.mimeType) {
        refs.push({
          id: row.id,
          mimeType: row.mimeType,
          channel: EMessagePlatform.App,
          sourceAddress: accountId,
        });
      }
    }

    return refs;
  }

  // The image's file and type while the conversation keeps it; undefined once it was deleted, or
  // for an id the conversation never had. Check ownership of the conversation first
  public async open(
    conversationKey: string,
    mediaId: string,
  ): Promise<TOption<{ file: BunFile; mimeType: string }>> {
    const row = await DatabaseConnector.instance.run((db) =>
      db
        .select()
        .from(appMediaTable)
        .where(
          and(eq(appMediaTable.id, mediaId), eq(appMediaTable.conversationKey, conversationKey)),
        )
        .get(),
    );

    if (row === undefined) {
      return undefined;
    }

    const file = Bun.file(join(this.directory, row.id));

    // a delete interrupted between the file and its row
    if (!(await file.exists())) {
      return undefined;
    }

    return { file, mimeType: row.mimeType };
  }

  public async fetchAttachment(
    ref: TAttachmentRef,
    maxBytes: number,
  ): Promise<TOption<Uint8Array>> {
    const file = Bun.file(join(this.directory, ref.id));

    if (file.size > maxBytes) {
      return undefined;
    }

    return file.bytes();
  }

  // NOTE: the file goes before its row, so a delete interrupted between the two leaves the row,
  // and a repeated delete removes it
  public async deleteAttachment(ref: TAttachmentRef): Promise<void> {
    await rm(join(this.directory, ref.id), { force: true });
    await DatabaseConnector.instance.run((db) =>
      db.delete(appMediaTable).where(eq(appMediaTable.id, ref.id)),
    );
  }
}
