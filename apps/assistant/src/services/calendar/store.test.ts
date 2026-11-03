import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

test("migration preserves existing Google calendars and enforces the cross-provider writer limit", async () => {
  const db = new Database(":memory:");
  try {
    db.run(
      "CREATE TABLE calendars (userId TEXT NOT NULL, calendarId TEXT NOT NULL, access TEXT NOT NULL, addedAt INTEGER NOT NULL, PRIMARY KEY(userId, calendarId))",
    );
    db.run(
      "CREATE UNIQUE INDEX calendars_single_write_unique ON calendars(userId) WHERE access = 'write'",
    );
    db.run(
      "INSERT INTO calendars VALUES ('chat', 'old-google-writer', 'write', 123), ('chat', 'old-google-reader', 'read', 456)",
    );
    const migration = await Bun.file(
      new URL("../../../migrations/0011_calendar_providers.sql", import.meta.url),
    ).text();
    db.exec(migration);
    expect(
      db
        .query("SELECT provider, calendarId, access, addedAt FROM calendars ORDER BY addedAt")
        .all(),
    ).toEqual([
      { provider: "google", calendarId: "old-google-writer", access: "write", addedAt: 123 },
      { provider: "google", calendarId: "old-google-reader", access: "read", addedAt: 456 },
    ]);
    db.run("INSERT INTO calendars VALUES ('chat', 'icloud', 'old-google-reader', 'read', 789)");
    expect(() =>
      db.run("INSERT INTO calendars VALUES ('chat', 'icloud', 'second-writer', 'write', 999)"),
    ).toThrow("UNIQUE");
  } finally {
    db.close();
  }
});
