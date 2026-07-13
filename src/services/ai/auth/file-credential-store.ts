import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { z } from "zod";

export const LOCAL_AI_CREDENTIALS_PATH = resolve(
  import.meta.dir,
  "../../../../.secrets/pi-auth.json",
);
let defaultAiCredentialsPath = LOCAL_AI_CREDENTIALS_PATH;
const configuredAiCredentialsPath = Bun.env.BELLACLAW_AI_CREDENTIALS_PATH?.trim();

if (configuredAiCredentialsPath !== undefined && configuredAiCredentialsPath.length > 0) {
  defaultAiCredentialsPath = resolve(configuredAiCredentialsPath);
}

export const AI_CREDENTIALS_PATH = defaultAiCredentialsPath;

const SApiKeyCredential = z.looseObject({
  type: z.literal("api_key"),
  key: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const SOAuthCredential = z.looseObject({
  type: z.literal("oauth"),
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number().nonnegative(),
});

const SCredential = z.discriminatedUnion("type", [SApiKeyCredential, SOAuthCredential]);
const SCredentials = z.record(z.string(), SCredential);

export class FileCredentialStore implements CredentialStore {
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(private path = AI_CREDENTIALS_PATH) {}

  public async read(providerId: string): Promise<Credential | undefined> {
    const credentials = await this.readAll();
    return credentials[providerId];
  }

  public modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const credentials = await this.readAll();
      const current = credentials[providerId];
      const next = await fn(current);

      if (next === undefined) {
        return current;
      }

      credentials[providerId] = next;
      await this.writeAll(credentials);
      return next;
    });
  }

  public delete(providerId: string): Promise<void> {
    return this.enqueue(async () => {
      const credentials = await this.readAll();

      if (credentials[providerId] === undefined) {
        return;
      }

      delete credentials[providerId];
      await this.writeAll(credentials);
    });
  }

  private enqueue<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const result = this.writeChain.catch(() => undefined).then(task);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readAll(): Promise<Record<string, Credential>> {
    const file = Bun.file(this.path);

    if (!(await file.exists())) {
      return {};
    }

    const parsed = SCredentials.safeParse(await file.json());

    if (!parsed.success) {
      throw new Error(`Invalid AI credentials file: ${this.path}`);
    }

    return parsed.data;
  }

  private async writeAll(credentials: Record<string, Credential>): Promise<void> {
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    const temporaryFile = await open(temporaryPath, "wx", 0o600);
    let temporaryFileOpen = true;

    try {
      await temporaryFile.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, "utf8");
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFileOpen = false;
      await rename(temporaryPath, this.path);

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
}
