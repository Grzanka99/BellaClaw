import { describe, expect, test } from "bun:test";
import { getNextFireTime } from "./parser";

describe("cron-engine timezone scheduling", () => {
  test("keeps existing local Date behavior without timezone", () => {
    const from = new Date(2025, 0, 1, 12, 30, 45, 0);
    const next = getNextFireTime("* * * * *", from);

    expect(next.getFullYear()).toBe(2025);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(12);
    expect(next.getMinutes()).toBe(31);
    expect(next.getSeconds()).toBe(0);
  });

  test("schedules Warsaw winter wall-clock time as the correct UTC instant", () => {
    const from = new Date("2026-01-01T07:30:00.000Z");
    const next = getNextFireTime("0 9 * * *", from, "Europe/Warsaw");

    expect(next.toISOString()).toBe("2026-01-01T08:00:00.000Z");
  });

  test("schedules Warsaw summer wall-clock time as the correct UTC instant", () => {
    const from = new Date("2026-07-01T06:30:00.000Z");
    const next = getNextFireTime("0 9 * * *", from, "Europe/Warsaw");

    expect(next.toISOString()).toBe("2026-07-01T07:00:00.000Z");
  });

  test("schedules the next matching weekday in the configured timezone", () => {
    const from = new Date("2026-01-02T10:00:00.000Z");
    const next = getNextFireTime("0 9 * * 1-5", from, "Europe/Warsaw");

    expect(next.toISOString()).toBe("2026-01-05T08:00:00.000Z");
  });
});
