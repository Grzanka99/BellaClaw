import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/services/database/schema.ts",
  out: "./migrations",
  dialect: "turso",
  dbCredentials: {
    url: "file:./test.db",
  },
});
