import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { AsyncQueue, repositoryPath, type TOption } from "@bellaclaw/shared";
import {
  OAuthClientInformationFullSchema,
  type OAuthClientInformationMixed,
  OAuthClientInformationSchema,
  type OAuthTokens,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";

const SStoredCredential = z.object({
  tokens: OAuthTokensSchema.optional(),
  clientInformation: z
    .union([OAuthClientInformationFullSchema, OAuthClientInformationSchema])
    .optional(),
  codeVerifier: z.string().min(1).optional(),
});

const SStoredCredentials = z.record(z.string(), SStoredCredential);

type TStoredCredential = z.infer<typeof SStoredCredential>;

export class McpAuthCredentialStore {
  private queue = new AsyncQueue();

  public constructor(private readonly configuredPath: TOption<string> = undefined) {}

  public async tokens(key: string): Promise<TOption<OAuthTokens>> {
    return (await this.readAll())[key]?.tokens;
  }

  public async clientInformation(key: string): Promise<TOption<OAuthClientInformationMixed>> {
    return (await this.readAll())[key]?.clientInformation;
  }

  public async codeVerifier(key: string): Promise<TOption<string>> {
    return (await this.readAll())[key]?.codeVerifier;
  }

  public saveTokens(key: string, tokens: OAuthTokens): Promise<void> {
    return this.update(key, (current) => ({ ...current, tokens }));
  }

  public saveClientInformation(
    key: string,
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    return this.update(key, (current) => ({ ...current, clientInformation }));
  }

  public saveCodeVerifier(key: string, codeVerifier: string): Promise<void> {
    return this.update(key, (current) => ({ ...current, codeVerifier }));
  }

  public async hasTokens(key: string): Promise<boolean> {
    return (await this.readAll())[key]?.tokens !== undefined;
  }

  public delete(key: string): Promise<boolean> {
    return this.queue.enqueue(async () => {
      const credentials = await this.readAll();
      if (credentials[key] === undefined) {
        return false;
      }

      delete credentials[key];
      await this.writeAll(credentials);
      return true;
    });
  }

  public clear(key: string, scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all") {
      return this.delete(key).then(() => undefined);
    }

    if (scope === "discovery") {
      return Promise.resolve();
    }

    return this.update(key, (current) => {
      if (scope === "client") {
        const { clientInformation: _clientInformation, ...remaining } = current;
        return remaining;
      }
      if (scope === "tokens") {
        const { tokens: _tokens, ...remaining } = current;
        return remaining;
      }

      const { codeVerifier: _codeVerifier, ...remaining } = current;
      return remaining;
    });
  }

  private update(key: string, change: (current: TStoredCredential) => TStoredCredential) {
    return this.queue.enqueue(async () => {
      const credentials = await this.readAll();
      credentials[key] = change(credentials[key] ?? {});
      await this.writeAll(credentials);
    });
  }

  private async readAll(): Promise<Record<string, TStoredCredential>> {
    const path = this.path();
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return {};
    }

    const parsed = SStoredCredentials.safeParse(await file.json());
    if (!parsed.success) {
      throw new Error(`Invalid MCP OAuth credentials file: ${path}`);
    }
    return parsed.data;
  }

  private async writeAll(credentials: Record<string, TStoredCredential>): Promise<void> {
    const path = this.path();
    const directory = dirname(path);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    const temporaryFile = await open(temporaryPath, "wx", 0o600);
    let temporaryFileOpen = true;

    try {
      await temporaryFile.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, "utf8");
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFileOpen = false;
      await rename(temporaryPath, path);

      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      if (temporaryFileOpen) {
        await temporaryFile.close().catch(() => undefined);
      }
      await rm(temporaryPath, { force: true });
    }
  }

  private path(): string {
    if (this.configuredPath !== undefined) {
      return repositoryPath(this.configuredPath);
    }

    const configuredPath = Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH?.trim();
    if (configuredPath !== undefined && configuredPath.length > 0) {
      return repositoryPath(configuredPath);
    }
    return repositoryPath(".secrets/mcp-credentials.json");
  }
}
