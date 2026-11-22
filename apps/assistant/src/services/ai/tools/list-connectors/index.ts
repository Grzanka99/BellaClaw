import { obj } from "@earendil-works/pi-schema";
import { ConnectorService } from "../../../connectors";
import { loadFileConnectors } from "../../../connectors/config";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const listConnectors = defineTool({
  name: "list-connectors",
  label: "List connectors",
  description:
    "List the connectors (external tool servers) the assistant knows for this user: the server-wide ones and the user's own in every status.",
  schema: obj({}, { description: "No arguments are required" }),
  instructions,
  mode: "parallel",
  logSafe: [],
  execute: async (context) => {
    const ownerKey = requireChatId(context.ownerKey);
    const fileConnectors = await loadFileConnectors();
    const stored = await ConnectorService.instance.listStored(ownerKey);

    return {
      serverConnectors: fileConnectors.map((connector) => ({
        id: connector.id,
        description: connector.description,
        serverWide: true,
        readOnly: true,
      })),
      userConnectors: stored.map((row) => ({
        id: row.id,
        kind: row.kind,
        url: row.url,
        description: row.description,
        plainChats: row.plainChats,
        status: row.status,
      })),
    };
  },
});
