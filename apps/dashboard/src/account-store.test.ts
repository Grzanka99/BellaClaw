import { expect, test } from "bun:test";
import { AccountStore } from "./account-store";

// a token that expires at 1_000
const LINK = { chatId: "signal:+100", nonce: "nonce", expiresAt: 1_000 };

test("every path that uses a token refuses an expired one", () => {
  const store = new AccountStore(":memory:");

  expect(store.createAccount("alice", "x", { ...LINK, nonce: "a" }, 1_000)).toEqual({
    failure: "linkUsed",
  });
  expect(store.findCredentials("alice")).toBeUndefined();

  const registration = store.createAccount("bob", "x", { ...LINK, nonce: "b" }, 500);

  if (!("account" in registration)) {
    throw new Error("not registered");
  }

  expect(
    store.redeemLoginLink(registration.account.id, { ...LINK, nonce: "c" }, "new", "cookie", 1_000),
  ).toBeUndefined();
  expect(store.findCredentials("bob")?.passwordHash).toBe("x");
  expect(
    store.redeemLoginLink(registration.account.id, { ...LINK, nonce: "c" }, "new", "cookie", 999),
  ).toBeString();
  expect(store.findCredentials("bob")?.passwordHash).toBe("new");
});
