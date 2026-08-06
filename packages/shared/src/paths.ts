import { resolve } from "node:path";

/**
 * Absolute path of the monorepo root. Every workspace resolves repository-level
 * paths (`.secrets`, hoisted `node_modules`, the behavior-log database) through
 * this constant so the depth is stated once instead of per file.
 */
export const REPOSITORY_ROOT = resolve(import.meta.dir, "../../..");

export function repositoryPath(...segments: string[]): string {
  return resolve(REPOSITORY_ROOT, ...segments);
}
