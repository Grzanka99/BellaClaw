import { defineConfig } from "drizzle-kit";

const TURSO_URL = Bun.env.TURSO_CONNECTION_URL;
const TURSO_TOKEN = Bun.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
  throw new Error("No turso creadentials");
}

export default defineConfig({
  schema: "./src/services/database/schema.ts",
  out: "./migrations",
  dialect: "turso",
  dbCredentials: {
    url: TURSO_URL,
    authToken: TURSO_TOKEN,
  },
});
