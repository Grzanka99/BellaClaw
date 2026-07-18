import { randomUUID } from "node:crypto";
import { link, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  AI_CREDENTIALS_PATH,
  LOCAL_AI_CREDENTIALS_PATH,
  SCredentials,
} from "../src/services/ai/auth/file-credential-store";

const SOURCE_PATH = resolve(import.meta.dir, "../.secrets/auth.json");
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

const SCodexAuth = z.object({
  tokens: z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    account_id: z.string().min(1),
  }),
});

const SPiAuth = SCredentials.refine((credentials) => Object.keys(credentials).length > 0);

type TPiAuth = z.infer<typeof SPiAuth>;

const SJwtPayload = z.object({
  exp: z.number().int().positive(),
});

export async function seedAuthFile(
  source: unknown,
  destinationPath: string,
  replaceExisting = false,
): Promise<boolean> {
  if (!replaceExisting && (await Bun.file(destinationPath).exists())) {
    return false;
  }

  const parsedPiAuth = SPiAuth.safeParse(source);
  let credentials: TPiAuth;

  if (parsedPiAuth.success) {
    credentials = parsedPiAuth.data;
  } else {
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

    credentials = {
      [OPENAI_CODEX_PROVIDER_ID]: {
        type: "oauth",
        access: accessToken,
        refresh: parsedSource.data.tokens.refresh_token,
        expires: parsedPayload.data.exp * 1000,
        accountId: parsedSource.data.tokens.account_id,
      },
    };
  }

  const destinationDirectory = dirname(destinationPath);
  const temporaryPath = `${destinationPath}.${randomUUID()}.tmp`;
  const temporaryFile = await open(temporaryPath, "wx", 0o600);
  let temporaryFileOpen = true;

  try {
    await temporaryFile.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, "utf8");
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFileOpen = false;

    if (replaceExisting) {
      await rename(temporaryPath, destinationPath);
    } else {
      try {
        await link(temporaryPath, destinationPath);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          return false;
        }

        throw error;
      }
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

  if (Bun.argv.includes("--local")) {
    const seeded = await seedAuthFile(await sourceFile.json(), LOCAL_AI_CREDENTIALS_PATH);

    if (seeded) {
      console.log(`Seeded local AI credentials: ${LOCAL_AI_CREDENTIALS_PATH}`);
      return;
    }

    console.log(`Local AI credentials already exist, preserving: ${LOCAL_AI_CREDENTIALS_PATH}`);
    return;
  }

  const reset = Bun.argv.includes("--reset");
  const args = [
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
  ];

  if (reset) {
    args.push("--reset");
  }

  const process = Bun.spawn(args, {
    cwd: resolve(import.meta.dir, ".."),
    stdin: sourceFile,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`Auth seed container failed with exit code ${exitCode}`);
  }
}

async function runInContainer(): Promise<void> {
  const reset = Bun.argv.includes("--reset");
  const seeded = await seedAuthFile(await Bun.stdin.json(), AI_CREDENTIALS_PATH, reset);

  if (seeded) {
    if (reset) {
      console.log(`Reset AI credentials: ${AI_CREDENTIALS_PATH}`);
    } else {
      console.log(`Seeded AI credentials: ${AI_CREDENTIALS_PATH}`);
    }
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
