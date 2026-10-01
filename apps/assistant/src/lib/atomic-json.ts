import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true });
  const temporaryFile = await open(temporaryPath, "wx", 0o600);
  let temporaryFileOpen = true;

  try {
    await temporaryFile.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
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
