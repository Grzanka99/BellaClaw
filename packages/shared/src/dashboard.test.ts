import { describe, expect, test } from "bun:test";
import {
  createDashboardLinkToken,
  DASHBOARD_LINK_TOKEN_TTL_MS,
  verifyDashboardLinkToken,
} from "./dashboard";

const SECRET = "dashboard-secret";
const CHAT_ID = "signal:+48123456789";
const NOW = 1_800_000_000_000;

describe("dashboard link token", () => {
  test("a fresh token verifies and returns the chat id", () => {
    const token = createDashboardLinkToken(SECRET, CHAT_ID, NOW);
    const verified = verifyDashboardLinkToken(SECRET, token, NOW + DASHBOARD_LINK_TOKEN_TTL_MS - 1);

    expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(verified?.chatId).toBe(CHAT_ID);
    expect(verified?.expiresAt).toBe(NOW + DASHBOARD_LINK_TOKEN_TTL_MS);
    expect(createDashboardLinkToken(SECRET, CHAT_ID, NOW)).not.toBe(token);
  });

  test("rejects an expired token", () => {
    const token = createDashboardLinkToken(SECRET, CHAT_ID, NOW);

    expect(verifyDashboardLinkToken(SECRET, token, NOW + DASHBOARD_LINK_TOKEN_TTL_MS)).toBe(
      undefined,
    );
  });

  test("rejects a token with a modified payload", () => {
    const [payload, signature] = createDashboardLinkToken(SECRET, CHAT_ID, NOW).split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload ?? "", "base64url").toString()),
        chatId: "discord:1234567890",
      }),
    ).toString("base64url");

    expect(verifyDashboardLinkToken(SECRET, `${forged}.${signature}`, NOW)).toBe(undefined);
  });

  test("rejects a token signed with another secret", () => {
    const token = createDashboardLinkToken("another-secret", CHAT_ID, NOW);

    expect(verifyDashboardLinkToken(SECRET, token, NOW)).toBe(undefined);
  });
});
