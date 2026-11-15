import { resolve } from "node:path";

export const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../migrations");
export const DRIZZLE_TEST_CONFIG_PATH = resolve(import.meta.dir, "../drizzle.test.config.ts");
