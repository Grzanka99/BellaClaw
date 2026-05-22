import { describe, expect, test } from "bun:test";
import { getNextFireTime, isValidCron } from "./parser";

describe("cron-engine parser", () => {
  test("isValidCron accepts simple valid pattern", () => {
    expect(isValidCron("*/5 * * * *")).toBe(true);
  });

  test("isValidCron rejects invalid pattern", () => {
    expect(isValidCron("not-a-cron")).toBe(false);
  });

  test("getNextFireTime returns next minute for wildcard pattern", () => {
    const from = new Date(2025, 0, 1, 12, 30, 45, 0);
    const next = getNextFireTime("* * * * *", from);

    expect(next.getFullYear()).toBe(2025);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(12);
    expect(next.getMinutes()).toBe(31);
    expect(next.getSeconds()).toBe(0);
  });

  test("getNextFireTime finds next weekday schedule", () => {
    const from = new Date(2025, 0, 3, 10, 0, 0, 0);
    const next = getNextFireTime("0 9 * * 1-5", from);

    expect(next.getDay()).toBeGreaterThanOrEqual(1);
    expect(next.getDay()).toBeLessThanOrEqual(5);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });
});
