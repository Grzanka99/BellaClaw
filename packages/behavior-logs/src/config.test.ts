import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { getDefaultLogDbPath } from "./config";
import type { TOption } from "./option";

const originalLogDbPath: TOption<string> = Bun.env.BELLACLAW_LOG_DB_PATH;
const originalLogDbRoot: TOption<string> = Bun.env.BELLACLAW_LOG_DB_ROOT;

afterEach(() => {
  restoreEnv("BELLACLAW_LOG_DB_PATH", originalLogDbPath);
  restoreEnv("BELLACLAW_LOG_DB_ROOT", originalLogDbRoot);
});

describe("behavior log configuration", () => {
  test("resolves configured relative paths from the repository root", () => {
    Bun.env.BELLACLAW_LOG_DB_PATH = "./tmp/behavior.db";
    delete Bun.env.BELLACLAW_LOG_DB_ROOT;

    expect(getDefaultLogDbPath()).toBe(resolve(import.meta.dir, "../../..", "tmp/behavior.db"));
  });
});

function restoreEnv(
  name: "BELLACLAW_LOG_DB_PATH" | "BELLACLAW_LOG_DB_ROOT",
  value: TOption<string>,
) {
  if (value === undefined) {
    delete Bun.env[name];
    return;
  }

  Bun.env[name] = value;
}
