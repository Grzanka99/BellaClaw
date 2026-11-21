import { obj } from "@earendil-works/pi-schema";
import { ListsService } from "../../../lists";
import { EConfigKey } from "../../../settings/schema";
import { defineTool, requireChatId } from "../define-tool";
import { toListsResult } from "../list-content";
import instructions from "./instructions.xml" with { type: "text" };

export const listLists = defineTool({
  name: "list-lists",
  label: "List lists",
  description:
    "List all of the user's to-do lists (shopping, packing, errands), expired ones included, with their item ids, texts, order and done state, end time, and whether each is expired or all done.",
  schema: obj({}, { description: "No arguments are required" }),
  instructions,
  mode: "parallel",
  logSafe: [],
  execute: async (context) => {
    const ownerKey = requireChatId(context.ownerKey);
    const lists = await ListsService.instance.list(ownerKey);

    return toListsResult(lists, context.settings[EConfigKey.AiInstructionsTimezone], Date.now());
  },
});
