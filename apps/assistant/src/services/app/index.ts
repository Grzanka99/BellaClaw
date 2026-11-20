import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  appDevicesTable,
  appMediaTable,
  EEventType,
  findOwnedConversation,
} from "@bellaclaw/database";
import {
  APP_PUSH_MAX_BYTES,
  createLogger,
  DEVICE_NOT_FOUND,
  repositoryPath,
  type TAppPush,
  type TDashboardMedia,
  type TLogger,
  type TOption,
} from "@bellaclaw/shared";
import type { BunFile } from "bun";
import { and, eq, inArray } from "drizzle-orm";
import { ConversationStore } from "../conversation";
import { DatabaseConnector, type TDatabaseHandle } from "../database";
import { ESubscriptionMode, EventBus } from "../events";
import { ERejectionCode } from "../events/catalog";
import { IdentityService, type TAccountKeys } from "../identity";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform, type TAttachmentRef, type TAttachmentStore } from "../messaging/types";
import { EPushResult, FcmClient } from "./fcm";
import { encryptForDevice } from "./web-push";

const DEFAULT_FCM_URL = "https://fcm.googleapis.com";

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

// The push of a row: its whole text when the JSON fits APP_PUSH_MAX_BYTES, else the longest start
// of it, cut between code points, that does
export function appPush(
  conversationKey: string,
  messageId: number,
  revision: number,
  text: string,
): TAppPush {
  const push = { conversationKey, messageId, revision, text, truncated: false };

  if (Buffer.byteLength(JSON.stringify(push)) <= APP_PUSH_MAX_BYTES) {
    return push;
  }

  let room =
    APP_PUSH_MAX_BYTES - Buffer.byteLength(JSON.stringify({ ...push, text: "", truncated: true }));
  let cut = "";

  for (const char of text) {
    // as JSON writes it, without the quotes
    const size = Buffer.byteLength(JSON.stringify(char)) - 2;

    if (size > room) {
      break;
    }

    room -= size;
    cut += char;
  }

  return { ...push, text: cut, truncated: true };
}

// NOTE: the App channel: the images the app uploads, kept on the assistant's data volume, one
// file per id, listed in app_media. It is the app's attachment store; the app has nothing to send.
// It also keeps the app's devices in app_devices, and which accounts have an open app stream at
// the edge
export class AppChannel implements TAttachmentStore {
  private static _instance: TOption<AppChannel>;
  private logger: TLogger = createLogger("APP");
  public readonly platform = EMessagePlatform.App;
  // the account of each device, by device id: loaded from app_devices, fed by
  // app.device.registered and app.device.unregistered
  private devices = new Map<string, string>();
  private loadPromise: TOption<Promise<void>>;
  // what the edge last reported, while its live connection is open; memory only
  private openStreams = new Set<string>();
  private edgeConnections = 0;
  // undefined while push is off: no FCM credential is configured
  private fcm: TOption<FcmClient>;
  private pushBackoffMs = [5_000, 30_000, 120_000];

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

  // NOTE: the read model has its own live consumer, so its update never waits behind a command
  // on the app consumer's lanes
  public async setup(): Promise<void> {
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

    // NOTE: one push for each reply, delivery or notice row on the app channel, to every device of
    // the account, while it has no app stream open. The row is stored already, whatever FCM does.
    // A token FCM no longer knows unregisters its device and is not tried again; any other failure
    // is retried, then logged and acked
    EventBus.instance.subscribe({
      consumer: "app",
      type: EEventType.ConversationChanged,
      mode: ESubscriptionMode.Durable,
      backoffMs: this.pushBackoffMs,
      handler: async (event, ctx) => {
        const { conversationKey, ownerKey, revision, messageId } = event.payload;
        const fcm = this.fcm;
        const accountId = IdentityService.instance.accountIdOf(ownerKey);

        if (fcm === undefined || messageId === undefined || accountId === undefined) {
          return;
        }

        if (this.hasOpenStream(accountId)) {
          return;
        }

        const message = await ConversationStore.instance.findMessage(conversationKey, messageId);

        if (message === undefined || message.channel !== EMessagePlatform.App) {
          return;
        }

        const devices = await DatabaseConnector.instance.run((db) =>
          db.select().from(appDevicesTable).where(eq(appDevicesTable.accountId, accountId)),
        );
        const plaintext = JSON.stringify(
          appPush(conversationKey, messageId, revision, message.message),
        );
        const gone: string[] = [];
        let failure: TOption<string>;

        for (const device of devices) {
          try {
            const ciphertext = await encryptForDevice(
              plaintext,
              device.publicKey,
              device.authSecret,
            );

            if ((await fcm.send(device.fcmToken, ciphertext)) === EPushResult.Unregistered) {
              gone.push(device.id);
            }
          } catch (error) {
            failure = String(error);
            this.logger.warning(`Push to device ${device.id} failed: ${failure}`);
          }
        }

        if (gone.length > 0) {
          this.logger.info(`FCM no longer knows devices ${gone.join(", ")}; unregistering them`);
          await ctx.transact(async (_tx, emit) => {
            for (const deviceId of gone) {
              emit(
                EEventType.AppDeviceUnregisterRequested,
                { deviceId, accountId },
                deviceId,
                "global",
              );
            }
          });
        }

        if (failure === undefined) {
          return;
        }

        if (!ctx.lastAttempt) {
          throw new Error(failure);
        }

        this.logger.error(`Push of message ${messageId} in ${conversationKey} given up`);
      },
    });

    EventBus.instance.subscribe({
      consumer: "app",
      type: EEventType.AppDeviceRegisterRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        const { deviceId, accountId, fcmToken, publicKey, authSecret } = event.payload;
        const registeredAt = new Date();

        await ctx.complete(async (tx, emit) => {
          await tx
            .insert(appDevicesTable)
            .values({ id: deviceId, accountId, fcmToken, publicKey, authSecret, registeredAt })
            .onConflictDoUpdate({
              target: appDevicesTable.id,
              set: { accountId, fcmToken, publicKey, authSecret, registeredAt },
            });
          emit(
            EEventType.AppDeviceRegistered,
            { deviceId, accountId, registeredAt: registeredAt.getTime() },
            undefined,
            undefined,
          );
        });
      },
    });
    EventBus.instance.subscribe({
      consumer: "app",
      type: EEventType.AppDeviceUnregisterRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        const { deviceId, accountId } = event.payload;

        await ctx.complete(async (tx, emit) => {
          const deleted = await tx
            .delete(appDevicesTable)
            .where(and(eq(appDevicesTable.id, deviceId), eq(appDevicesTable.accountId, accountId)))
            .returning({ id: appDevicesTable.id });

          if (deleted.length === 0) {
            emit(
              EEventType.CommandRejected,
              {
                commandType: event.type,
                code: ERejectionCode.Invalid,
                message: "The account holds no such device",
                errorCode: DEVICE_NOT_FOUND,
              },
              undefined,
              undefined,
            );
            return;
          }

          emit(EEventType.AppDeviceUnregistered, { deviceId, accountId }, undefined, undefined);
        });
      },
    });
    EventBus.instance.subscribe({
      consumer: "app-cache",
      type: EEventType.AppDeviceRegistered,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: async (event) => {
        this.devices.set(event.payload.deviceId, event.payload.accountId);
      },
    });
    EventBus.instance.subscribe({
      consumer: "app-cache",
      type: EEventType.AppDeviceUnregistered,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: async (event) => {
        this.devices.delete(event.payload.deviceId);
      },
    });

    await Promise.all([this.load(), this.loadPush()]);
  }

  // NOTE: the credential is read only here, in the assistant; push stays off without it
  private async loadPush(): Promise<void> {
    const path = Bun.env.BELLACLAW_FCM_CREDENTIALS_PATH?.trim() ?? "";

    if (path.length === 0 || !(await Bun.file(path).exists())) {
      this.logger.info("Push is off: no FCM credential is configured");
      return;
    }

    try {
      this.fcm = await FcmClient.load(path, Bun.env.BELLACLAW_FCM_URL?.trim() || DEFAULT_FCM_URL);
      this.logger.info("Push is on");
    } catch {
      // the error's text could quote the file
      this.logger.error(`Push is off: the FCM credential at ${path} is not a service-account key`);
    }
  }

  // whether the account has a registered device: the app is then its main channel
  public async hasDevice(accountId: string): Promise<boolean> {
    await this.load();

    return [...this.devices.values()].includes(accountId);
  }

  // the ids of the account's registered devices
  public async listDeviceIds(accountId: string): Promise<string[]> {
    await this.load();

    return [...this.devices]
      .filter(([, deviceAccountId]) => deviceAccountId === accountId)
      .map(([deviceId]) => deviceId);
  }

  // every account with a registered device, once
  public async listDeviceAccounts(): Promise<string[]> {
    await this.load();

    return [...new Set(this.devices.values())];
  }

  // NOTE: presence holds only while the edge's live connection is open: the edge reports again on
  // every connection, and a dropped one reads closed for every account. Returns what ends it
  public openEdgeConnection(): () => void {
    let open = true;
    this.edgeConnections += 1;

    return () => {
      if (!open) {
        return;
      }

      open = false;
      this.edgeConnections -= 1;

      if (this.edgeConnections === 0) {
        this.openStreams.clear();
      }
    };
  }

  // accountIds: every account with an open app stream, as the edge reports it; ignored while the
  // edge has no live connection
  public reportPresence(accountIds: string[]): void {
    if (this.edgeConnections === 0) {
      return;
    }

    this.openStreams = new Set(accountIds);
  }

  // whether the account has an open app stream at the edge; false after a restart until the edge
  // reports
  public hasOpenStream(accountId: string): boolean {
    return this.openStreams.has(accountId);
  }

  private load(): Promise<void> {
    if (this.loadPromise === undefined) {
      this.loadPromise = this.loadDevices();
    }

    return this.loadPromise;
  }

  private async loadDevices(): Promise<void> {
    const rows = await DatabaseConnector.instance.run((db) =>
      db
        .select({ id: appDevicesTable.id, accountId: appDevicesTable.accountId })
        .from(appDevicesTable),
    );

    for (const row of rows) {
      this.devices.set(row.id, row.accountId);
    }
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
