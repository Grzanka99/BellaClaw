import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

// NOTE: schema is absolute so the assistant test preload can push from its own directory, and the
// database file stays relative to the caller's working directory; generate runs from this directory
export default defineConfig({
  schema: resolve(import.meta.dir, "src/schema.ts"),
  out: "./migrations",
  dialect: "turso",
  dbCredentials: {
    url: "file:./test.db",
  },
});
