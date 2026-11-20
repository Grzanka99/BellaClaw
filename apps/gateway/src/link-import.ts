import { ADDRESS_LINKED_ELSEWHERE, createLogger } from "@bellaclaw/shared";
import type { AccountStore } from "./account-store";
import type { TInternalApi } from "./internal-api";

const logger = createLogger("LINK-IMPORT");

// Requests a link for every row of account_chats, oldest first, one at a time: the next starts
// once the link before is active, which removes its row. A row whose chat is linked to another
// account is logged and left. Ends when no other row is left, dropping the table when it holds no
// row; a row whose account does not exist is logged and stays. A restart picks up where it ended.
// NOTE: a chat key is a phone number or another personal address, so no log line names one
// waitMs: the pause before the next look at a link being made, or at an unreachable assistant
export async function importAccountChats(
  store: AccountStore,
  internalApi: TInternalApi,
  waitMs: number,
): Promise<void> {
  const skipped = new Set<string>();

  for (;;) {
    const row = store.nextImportRow(skipped);

    if (row === undefined) {
      const { orphanAccountIds } = store.finishImport();

      if (orphanAccountIds.length > 0) {
        logger.error(
          `Rows of missing accounts ${orphanAccountIds.join(", ")} stay in account_chats`,
        );
      }

      return;
    }

    const chatLink = await internalApi.getChatLink(row.chatId);

    if ("error" in chatLink) {
      logger.warning(
        `Link of a chat of account ${row.accountId} not readable, retrying: ${chatLink.error}`,
      );
      await Bun.sleep(waitMs);
      continue;
    }

    const link = chatLink.data.link;

    if (link === undefined) {
      const requested = await internalApi.requestLink(row.publicId, row.chatId);

      if ("error" in requested && requested.code === ADDRESS_LINKED_ELSEWHERE) {
        logger.error(
          `A chat of account ${row.accountId} is linked to another account; its row stays`,
        );
        skipped.add(row.chatId);
      } else if ("error" in requested) {
        logger.warning(
          `Link of a chat of account ${row.accountId} not requested, retrying: ${requested.error}`,
        );
        await Bun.sleep(waitMs);
      }

      continue;
    }

    if (link.accountId !== row.publicId) {
      logger.error(
        `A chat of account ${row.accountId} is linked to another account; its row stays`,
      );
      skipped.add(row.chatId);
      continue;
    }

    if (link.state === "active") {
      store.deleteImportRow(row.chatId);
      logger.info(`A chat of account ${row.accountId} is linked`);
      continue;
    }

    await Bun.sleep(waitMs);
  }
}
