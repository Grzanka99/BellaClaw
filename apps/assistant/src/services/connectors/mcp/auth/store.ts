import { AsyncQueue, repositoryPath, type TOption } from "@bellaclaw/shared";
import {
  OAuthClientInformationFullSchema,
  type OAuthClientInformationMixed,
  OAuthClientInformationSchema,
  type OAuthTokens,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { writeJsonAtomically } from "../../../../lib/atomic-json";

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
      await writeJsonAtomically(this.path(), credentials);
      return true;
    });
  }

  // Moves every credential whose key starts with from to the same key under to, or drops them
  // when a key under to exists already. Returns the moved or dropped keys
  public moveAll(from: string, to: string): Promise<string[]> {
    return this.queue.enqueue(async () => {
      const credentials = await this.readAll();
      const moving = Object.entries(credentials).filter(([key]) => key.startsWith(from));

      if (moving.length === 0) {
        return [];
      }

      const kept = Object.keys(credentials).some((key) => key.startsWith(to));

      for (const [key, value] of moving) {
        if (!kept) {
          credentials[`${to}${key.slice(from.length)}`] = value;
        }

        delete credentials[key];
      }

      await writeJsonAtomically(this.path(), credentials);
      return moving.map(([key]) => key);
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
      await writeJsonAtomically(this.path(), credentials);
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
