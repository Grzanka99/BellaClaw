import { randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { AI_CREDENTIALS_PATH } from "../src/services/ai/auth/file-credential-store";

const SOURCE_PATH = resolve(import.meta.dir, "../.secrets/auth.json");
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

const SCodexAuth = z.object({
  tokens: z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    account_id: z.string().min(1),
  }),
});

const SJwtPayload = z.object({
  exp: z.number().int().positive(),
});

export async function seedAuthFile(source: unknown, destinationPath: string): Promise<boolean> {
  if (await Bun.file(destinationPath).exists()) {
    return false;
  }

  const parsedSource = SCodexAuth.safeParse(source);

  if (!parsedSource.success) {
    throw new Error("Invalid Codex auth file");
  }

  const accessToken = parsedSource.data.tokens.access_token;
  const payloadSegment = accessToken.split(".")[1];

  if (payloadSegment === undefined) {
    throw new Error("Invalid Codex access token");
  }

  let jwtPayload: unknown;

  try {
    jwtPayload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid Codex access token payload");
  }

  const parsedPayload = SJwtPayload.safeParse(jwtPayload);

  if (!parsedPayload.success) {
    throw new Error("Codex access token has no valid expiration");
  }

  const credentials = {
    [OPENAI_CODEX_PROVIDER_ID]: {
      type: "oauth",
      access: accessToken,
      refresh: parsedSource.data.tokens.refresh_token,
      expires: parsedPayload.data.exp * 1000,
      accountId: parsedSource.data.tokens.account_id,
    },
  };

  const destinationDirectory = dirname(destinationPath);
  const temporaryPath = `${destinationPath}.${randomUUID()}.tmp`;
  const temporaryFile = await open(temporaryPath, "wx", 0o600);
  let temporaryFileOpen = true;

  try {
    await temporaryFile.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, "utf8");
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFileOpen = false;

    try {
      await link(temporaryPath, destinationPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        return false;
      }

      throw error;
    }

    const directoryHandle = await open(destinationDirectory, "r");

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

  return true;
}

async function runOnHost(): Promise<void> {
  const sourceFile = Bun.file(SOURCE_PATH);

  if (!(await sourceFile.exists())) {
    console.log(`Auth seed not found, skipping: ${SOURCE_PATH}`);
    return;
  }

  const process = Bun.spawn(
    [
      "podman",
      "compose",
      "--profile",
      "signal",
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "bellaclaw",
      "bun",
      "run",
      "scripts/seed-auth.ts",
      "--container",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      stdin: sourceFile,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`Auth seed container failed with exit code ${exitCode}`);
  }
}

async function runInContainer(): Promise<void> {
  const seeded = await seedAuthFile(await Bun.stdin.json(), AI_CREDENTIALS_PATH);

  if (seeded) {
    console.log(`Seeded AI credentials: ${AI_CREDENTIALS_PATH}`);
    return;
  }

  console.log(`AI credentials already exist, preserving: ${AI_CREDENTIALS_PATH}`);
}

if (import.meta.main) {
  if (Bun.argv.includes("--container")) {
    await runInContainer();
  } else {
    await runOnHost();
  }
}
