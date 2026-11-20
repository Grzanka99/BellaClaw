import type { EConversationKind } from "@bellaclaw/database";
import { appDevicesTable, EEventType } from "@bellaclaw/database";
import { APP_PUSH_MAX_BYTES, createLogger, type TAppPush, type TOption } from "@bellaclaw/shared";
import { eq } from "drizzle-orm";
import { ConversationStore } from "../conversation";
import { DatabaseConnector } from "../database";
import { ESubscriptionMode, EventBus } from "../events";
import { IdentityService } from "../identity";
import { EMessagePlatform } from "../messaging/types";
import type { AppChannel } from ".";
import { EPushResult, FcmClient } from "./fcm";
import { encryptForDevice } from "./web-push";

const DEFAULT_FCM_URL = "https://fcm.googleapis.com";
const logger = createLogger("APP");

// The push of a row: its whole text when the JSON fits APP_PUSH_MAX_BYTES, else the longest start
// of it, cut between code points, that does
export function appPush(
  conversationKey: string,
  kind: EConversationKind,
  messageId: number,
  revision: number,
  text: string,
): TAppPush {
  const push = { conversationKey, kind, messageId, revision, text, truncated: false };

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

// The App channel's push: subscribes, and returns what loads the FCM credential. channel: whose
// open streams hold a push back
export function setupPush(channel: AppChannel, backoffMs: number[]): () => Promise<void> {
  // undefined while push is off: no FCM credential is configured
  let fcmClient: TOption<FcmClient>;

  // NOTE: one push for each reply, delivery or notice row on the app channel, to every device of
  // the account, while it has no app stream open. The row is stored already, whatever FCM does.
  // A token FCM no longer knows unregisters its device and is not tried again; any other failure
  // is retried, then logged and acked
  EventBus.instance.subscribe({
    consumer: "app",
    type: EEventType.ConversationChanged,
    mode: ESubscriptionMode.Durable,
    backoffMs,
    handler: async (event, ctx) => {
      const { conversationKey, ownerKey, revision, messageId } = event.payload;
      const fcm = fcmClient;
      const accountId = IdentityService.instance.accountIdOf(ownerKey);

      if (fcm === undefined || messageId === undefined || accountId === undefined) {
        return;
      }

      if (channel.hasOpenStream(accountId)) {
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
        appPush(conversationKey, message.kind, messageId, revision, message.message),
      );
      const gone: string[] = [];
      let failure: TOption<string>;

      for (const device of devices) {
        try {
          const ciphertext = await encryptForDevice(plaintext, device.publicKey, device.authSecret);

          if ((await fcm.send(device.fcmToken, ciphertext)) === EPushResult.Unregistered) {
            gone.push(device.id);
          }
        } catch (error) {
          failure = String(error);
          logger.warning(`Push to device ${device.id} failed: ${failure}`);
        }
      }

      if (gone.length > 0) {
        logger.info(`FCM no longer knows devices ${gone.join(", ")}; unregistering them`);
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

      logger.error(`Push of message ${messageId} in ${conversationKey} given up`);
    },
  });

  return async () => {
    fcmClient = await loadPush();
  };
}

// NOTE: the credential is read only here, in the assistant; push stays off without it
async function loadPush(): Promise<TOption<FcmClient>> {
  const path = Bun.env.BELLACLAW_FCM_CREDENTIALS_PATH?.trim() ?? "";

  if (path.length === 0 || !(await Bun.file(path).exists())) {
    logger.info("Push is off: no FCM credential is configured");
    return undefined;
  }

  try {
    const fcm = await FcmClient.load(path, Bun.env.BELLACLAW_FCM_URL?.trim() || DEFAULT_FCM_URL);
    logger.info("Push is on");
    return fcm;
  } catch {
    // the error's text could quote the file
    logger.error(`Push is off: the FCM credential at ${path} is not a service-account key`);
    return undefined;
  }
}
