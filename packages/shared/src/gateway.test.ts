import { describe, expect, test } from "bun:test";
import {
  createGatewayLinkToken,
  GATEWAY_LINK_TOKEN_TTL_MS,
  verifyGatewayLinkToken,
} from "./gateway";

const SECRET = "gateway-secret";
const CHAT_ID = "signal:+48123456789";
const NOW = 1_800_000_000_000;

describe("gateway link token", () => {
  test("a fresh token verifies and returns the chat id", () => {
    const token = createGatewayLinkToken(SECRET, CHAT_ID, NOW);
    const verified = verifyGatewayLinkToken(SECRET, token, NOW + GATEWAY_LINK_TOKEN_TTL_MS - 1);

    expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(verified?.chatId).toBe(CHAT_ID);
    expect(verified?.expiresAt).toBe(NOW + GATEWAY_LINK_TOKEN_TTL_MS);
    expect(createGatewayLinkToken(SECRET, CHAT_ID, NOW)).not.toBe(token);
  });

  test("rejects an expired token", () => {
    const token = createGatewayLinkToken(SECRET, CHAT_ID, NOW);

    expect(verifyGatewayLinkToken(SECRET, token, NOW + GATEWAY_LINK_TOKEN_TTL_MS)).toBe(undefined);
  });

  test("rejects a token with a modified payload", () => {
    const [payload, signature] = createGatewayLinkToken(SECRET, CHAT_ID, NOW).split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload ?? "", "base64url").toString()),
        chatId: "discord:1234567890",
      }),
    ).toString("base64url");

    expect(verifyGatewayLinkToken(SECRET, `${forged}.${signature}`, NOW)).toBe(undefined);
  });

  test("rejects a token signed with another secret", () => {
    const token = createGatewayLinkToken("another-secret", CHAT_ID, NOW);

    expect(verifyGatewayLinkToken(SECRET, token, NOW)).toBe(undefined);
  });
});
