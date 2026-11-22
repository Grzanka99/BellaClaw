import { connectorsTable, EConnectorStatus } from "@bellaclaw/database";
import { repositoryPath, SConnectorId, type TOption } from "@bellaclaw/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { DatabaseConnector } from "../database";

const REQUEST_TIMEOUT_MS = 120_000;
const INPUT_TIMEOUT_MS = 900_000;

const SOAuth = z
  .object({
    clientIdEnv: z.string().optional(),
    clientSecretEnv: z.string().optional(),
    scopes: z.array(z.string()).default([]),
    authorizationParams: z.record(z.string(), z.string()).default({}),
  })
  .refine((oauth) => oauth.clientSecretEnv === undefined || oauth.clientIdEnv !== undefined, {
    message: "MCP OAuth clientSecretEnv requires clientIdEnv",
  });

export const SConnector = z.object({
  id: SConnectorId,
  description: z.string().min(1),
  instructions: z.string().min(1),
  transport: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).default({}),
    }),
    z
      .object({
        type: z.literal("http"),
        url: z
          .string()
          .transform((url) =>
            url.replace(/\$\{([A-Z][A-Z0-9_]*)(?::-([^}]*))?\}/g, (_match, name, fallback) => {
              const value = Bun.env[name]?.trim();
              if (value !== undefined && value.length > 0) {
                return value;
              }
              return fallback ?? "";
            }),
          )
          .pipe(z.url()),
        headers: z.record(z.string(), z.string()).default({}),
        oauth: SOAuth.optional(),
        tokenAuth: z.boolean().default(false),
      })
      .refine((transport) => transport.oauth === undefined || !transport.tokenAuth, {
        message: "Connector cannot use both oauth and tokenAuth",
      }),
  ]),
  tools: z.array(z.string()).optional(),
  contextArguments: z
    .record(z.string(), z.enum(["ownerKey", "conversationKey", "turnId"]))
    .default({}),
  resources: z.boolean().default(true),
  prompts: z.boolean().default(true),
  sampling: z.boolean().default(true),
  // true: the app's plain chats may use the connector; closed to them by default, as a connector may
  // hold the user's personal notes
  plainChats: z.boolean().default(false),
  requestTimeoutMs: z.number().int().positive().default(REQUEST_TIMEOUT_MS),
  inputTimeoutMs: z.number().int().positive().default(INPUT_TIMEOUT_MS),
});

// instructions: the operator's, from connectors.json only
export type TConnector = Omit<z.infer<typeof SConnector>, "instructions"> & {
  instructions: TOption<string>;
};

const SConnectorsConfig = z.object({ connectors: z.array(SConnector) });

// the operator's connectors.json, the same for every owner
export async function loadFileConnectors(): Promise<TConnector[]> {
  const configuredPath = Bun.env.BELLACLAW_CONNECTORS_CONFIG?.trim();
  let path = repositoryPath("connectors.json");
  if (configuredPath !== undefined && configuredPath.length > 0) {
    path = repositoryPath(configuredPath);
  }
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return [];
  }
  const parsed = SConnectorsConfig.safeParse(await file.json());
  if (!parsed.success) {
    throw new Error(`Invalid connectors configuration: ${parsed.error.message}`);
  }
  const ids = new Set<string>();
  for (const connector of parsed.data.connectors) {
    if (ids.has(connector.id)) {
      throw new Error(`Duplicate connector: ${connector.id}`);
    }
    ids.add(connector.id);
  }
  return parsed.data.connectors;
}

// the file's connectors and the owner's usable stored ones (active, or pending removal); a stored
// connector whose id the file also has is left out
export async function loadConnectors(ownerKey: string): Promise<TConnector[]> {
  const fileConnectors = await loadFileConnectors();
  const rows = await DatabaseConnector.instance.run((db) =>
    db
      .select()
      .from(connectorsTable)
      .where(
        and(
          eq(connectorsTable.ownerKey, ownerKey),
          inArray(connectorsTable.status, [
            EConnectorStatus.Active,
            EConnectorStatus.PendingRemoval,
          ]),
        ),
      )
      .orderBy(asc(connectorsTable.createdAt)),
  );
  const fileIds = new Set(fileConnectors.map((connector) => connector.id));
  const stored: TConnector[] = rows
    .filter((row) => !fileIds.has(row.id))
    .map((row) => storedConnector(row));
  return [...fileConnectors, ...stored];
}

export type TStoredConnectorFields = Pick<
  typeof connectorsTable.$inferSelect,
  "id" | "url" | "description" | "plainChats"
>;

// the connector a stored row gives
export function storedConnector(row: TStoredConnectorFields): TConnector {
  return {
    id: row.id,
    description: row.description,
    instructions: undefined,
    transport: { type: "http", url: row.url, headers: {}, oauth: undefined, tokenAuth: false },
    tools: undefined,
    contextArguments: {},
    resources: true,
    prompts: true,
    sampling: true,
    plainChats: row.plainChats,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    inputTimeoutMs: INPUT_TIMEOUT_MS,
  };
}

export async function getConnector(ownerKey: string, id: string): Promise<TConnector> {
  const connector = (await loadConnectors(ownerKey)).find((candidate) => candidate.id === id);
  if (connector === undefined) {
    throw new Error(`Unknown connector: ${id}`);
  }
  return connector;
}
