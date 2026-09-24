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

export const SMcpProfile = z.object({
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
    z.object({
      type: z.literal("http"),
      url: z.url(),
      headers: z.record(z.string(), z.string()).default({}),
      oauth: SOAuth.optional(),
    }),
  ]),
  tools: z.array(z.string()).optional(),
  contextArguments: z.record(z.string(), z.enum(["chatId", "turnId"])).default({}),
  resources: z.boolean().default(true),
  prompts: z.boolean().default(true),
  sampling: z.boolean().default(true),
  requestTimeoutMs: z.number().int().positive().default(120_000),
  inputTimeoutMs: z.number().int().positive().default(900_000),
});

export type TMcpProfile = z.infer<typeof SMcpProfile>;

const SMcpConfig = z.object({ profiles: z.array(SMcpProfile) });

export async function loadMcpProfiles(): Promise<TMcpProfile[]> {
  const configuredPath = Bun.env.BELLACLAW_MCP_CONFIG?.trim();
  let path = repositoryPath("mcp.json");
  if (configuredPath !== undefined && configuredPath.length > 0) {
    path = repositoryPath(configuredPath);
  }
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return [];
  }
  const parsed = SMcpConfig.safeParse(await file.json());
  if (!parsed.success) {
    throw new Error(`Invalid MCP configuration: ${parsed.error.message}`);
  }
  const ids = new Set<string>();
  for (const profile of parsed.data.profiles) {
    if (ids.has(profile.id)) {
      throw new Error(`Duplicate MCP profile: ${profile.id}`);
    }
    ids.add(profile.id);
  }
  return parsed.data.profiles;
}

export async function getMcpProfile(id: string): Promise<TMcpProfile> {
  const profile = (await loadMcpProfiles()).find((candidate) => candidate.id === id);
  if (profile === undefined) {
    throw new Error(`Unknown MCP profile: ${id}`);
  }
  return profile;
}
