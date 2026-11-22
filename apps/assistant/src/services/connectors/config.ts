import { repositoryPath } from "@bellaclaw/shared";
import { z } from "zod";

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
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
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
  requestTimeoutMs: z.number().int().positive().default(120_000),
  inputTimeoutMs: z.number().int().positive().default(900_000),
});

export type TConnector = z.infer<typeof SConnector>;

const SConnectorsConfig = z.object({ connectors: z.array(SConnector) });

export async function loadConnectors(): Promise<TConnector[]> {
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

export async function getConnector(id: string): Promise<TConnector> {
  const connector = (await loadConnectors()).find((candidate) => candidate.id === id);
  if (connector === undefined) {
    throw new Error(`Unknown connector: ${id}`);
  }
  return connector;
}
