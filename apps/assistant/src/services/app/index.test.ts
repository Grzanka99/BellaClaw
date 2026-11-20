import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appDevicesTable, EEventType, eventsTable } from "@bellaclaw/database";
import {
  DASHBOARD_PRESENCE_PATH,
  dashboardAccountDevicePath,
  dashboardAccountDevicesPath,
} from "@bellaclaw/shared";
import { asc, eq } from "drizzle-orm";
import { DatabaseConnector } from "../database";
import { resetEventTables } from "../database/test-utils";
import { EventBus } from "../events";
import { IdentityService } from "../identity";
import { handleInternalApiRequest, setupInternalApi } from "../internal-api";
import { AppChannel } from ".";

const SECRET = "internal-secret";

// real P-256 public keys, uncompressed, base64url
const PUBLIC_KEYS = [
  "BA45xSmkpu16iOb3SDdemng3MY0BBUBpXQTZ9_u_XrgBhMbbDrSUSmJs3hm6zHVYq1DuFSV7hLcvavZQMDe4UkM",
  "BK0NaeMoGRCI4PAxQ1dSlLqaFvREgqUAxC-3HUWgt3y8p-tA24e65EW5mBBtfZ4psKk118_YVeyD9_YEMuKyxWM",
];

// RFC 8291 key material of PUBLIC_KEYS[index], base64url
function keys(index: number) {
  return {
    publicKey: PUBLIC_KEYS[index] ?? "",
    authSecret: Buffer.from(new Uint8Array(16).fill(index + 1)).toString("base64url"),
  };
}

function reset() {
  Object.assign(EventBus, { _instance: undefined });
  Object.assign(IdentityService, { _instance: undefined });
  Object.assign(AppChannel, { _instance: undefined });
}

function send(method: string, path: string, body: unknown, signal?: AbortSignal) {
  return handleInternalApiRequest(
    new Request(`http://internal${path}`, {
      method,
      headers: { Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
      signal,
    }),
    SECRET,
  );
}

function register(accountId: string, deviceId: string, fcmToken: string, index: number) {
  return send("PUT", dashboardAccountDevicePath(accountId, deviceId), { fcmToken, ...keys(index) });
}

function unregister(accountId: string, deviceId: string) {
  return send("DELETE", dashboardAccountDevicePath(accountId, deviceId), undefined);
}

function devices() {
  return DatabaseConnector.instance.database
    .select({
      id: appDevicesTable.id,
      accountId: appDevicesTable.accountId,
      fcmToken: appDevicesTable.fcmToken,
      publicKey: appDevicesTable.publicKey,
      authSecret: appDevicesTable.authSecret,
    })
    .from(appDevicesTable);
}

async function start() {
  await AppChannel.instance.setup();
  setupInternalApi();
  await IdentityService.instance.setup();
  await EventBus.instance.start();
}

// the edge's live connection, open until the returned function closes it
async function openEdgeConnection() {
  const aborted = new AbortController();
  const response = await send("GET", "/internal/stream", undefined, aborted.signal);
  const reader = response.body?.getReader();
  await reader?.read();

  return async () => {
    aborted.abort();
    await reader?.cancel();
  };
}

beforeEach(async () => {
  reset();
  await resetEventTables();
  await DatabaseConnector.instance.database.delete(appDevicesTable);
});

afterEach(async () => {
  await EventBus.instance.idle();
  await EventBus.instance.stop();
  await DatabaseConnector.instance.database.delete(appDevicesTable);
  reset();
});

describe("AppChannel devices", () => {
  test("registering an id again keeps one device with the new token and keys", async () => {
    await start();

    expect(await (await register("acct-1", "phone-1", "token-a", 0)).json()).toEqual({
      deviceId: "phone-1",
    });
    expect((await register("acct-1", "phone-1", "token-b", 1)).status).toBe(200);

    expect(await devices()).toEqual([
      { id: "phone-1", accountId: "acct-1", fcmToken: "token-b", ...keys(1) },
    ]);
    expect(await AppChannel.instance.hasDevice("acct-1")).toBe(true);
    // the command's key material leaves the log once it is handled
    const commands = await DatabaseConnector.instance.database
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.AppDeviceRegisterRequested))
      .orderBy(asc(eventsTable.seq));
    expect(commands).toEqual([{ payload: null }, { payload: null }]);
  });

  test("an unregister removes the account's device; an unknown id or another account's device is a 404 that changes nothing", async () => {
    await start();
    await register("acct-1", "phone-1", "token-a", 0);
    await register("acct-1", "phone-2", "token-b", 1);

    expect((await unregister("acct-1", "unknown")).status).toBe(404);
    expect((await unregister("acct-2", "phone-1")).status).toBe(404);
    expect((await devices()).map((row) => row.id).sort()).toEqual(["phone-1", "phone-2"]);

    expect(await (await unregister("acct-1", "phone-1")).json()).toEqual({ deviceId: "phone-1" });
    // an account has a device while one is registered
    expect(await AppChannel.instance.hasDevice("acct-1")).toBe(true);
    expect((await unregister("acct-1", "phone-2")).status).toBe(200);

    expect(await devices()).toEqual([]);
    expect(await AppChannel.instance.hasDevice("acct-1")).toBe(false);
  });

  test("unregistering every device of an account removes its devices and leaves another account's", async () => {
    await start();
    await register("acct-1", "phone-1", "token-a", 0);
    await register("acct-1", "phone-2", "token-b", 1);
    await register("acct-2", "phone-3", "token-c", 0);

    const removed = await send("DELETE", dashboardAccountDevicesPath("acct-1"), undefined);

    expect(await removed.json()).toEqual({ deviceIds: ["phone-1", "phone-2"] });
    expect((await devices()).map((row) => row.id)).toEqual(["phone-3"]);
    expect(await AppChannel.instance.hasDevice("acct-1")).toBe(false);
    expect(
      await (await send("DELETE", dashboardAccountDevicesPath("acct-1"), undefined)).json(),
    ).toEqual({ deviceIds: [] });
  });

  test("a register with malformed or off-curve keys, token or id is refused before any command", async () => {
    await start();
    const valid = { fcmToken: "token", ...keys(0) };
    const compressed = Buffer.from(new Uint8Array(65).fill(3)).toString("base64url");
    const offCurve = new Uint8Array(65);
    offCurve[0] = 0x04;

    for (const body of [
      { ...valid, publicKey: Buffer.from(offCurve).toString("base64url") },
      { ...valid, publicKey: Buffer.from(new Uint8Array(33).fill(4)).toString("base64url") },
      { ...valid, publicKey: compressed },
      { ...valid, authSecret: Buffer.from(new Uint8Array(15)).toString("base64url") },
      { ...valid, authSecret: `${valid.authSecret}+` },
      { ...valid, fcmToken: "" },
      { ...valid, fcmToken: "x".repeat(4097) },
      { ...valid, extra: true },
    ]) {
      expect(
        (await send("PUT", dashboardAccountDevicePath("acct-1", "phone-1"), body)).status,
      ).toBe(400);
    }
    expect((await send("PUT", dashboardAccountDevicePath("acct-1", "phone.1"), valid)).status).toBe(
      400,
    );

    const commands = await DatabaseConnector.instance.database
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.AppDeviceRegisterRequested));
    expect(commands).toEqual([]);
  });

  test("the device read model is loaded again after a restart", async () => {
    await start();
    await register("acct-1", "phone-1", "token-a", 0);
    await EventBus.instance.idle();
    await EventBus.instance.stop();
    reset();

    await start();

    expect(await AppChannel.instance.hasDevice("acct-1")).toBe(true);
    expect(await AppChannel.instance.hasDevice("acct-2")).toBe(false);
  });
});

describe("AppChannel presence", () => {
  test("the edge's report is readable while its connection is open, and a dropped connection reads closed for everyone", async () => {
    await start();
    const close = await openEdgeConnection();

    expect(
      await (
        await send("POST", DASHBOARD_PRESENCE_PATH, { accountIds: ["acct-1", "acct-2"] })
      ).json(),
    ).toEqual({ ok: true });
    expect(AppChannel.instance.hasOpenStream("acct-1")).toBe(true);
    expect(AppChannel.instance.hasOpenStream("acct-2")).toBe(true);

    // a stream closed at the edge
    await send("POST", DASHBOARD_PRESENCE_PATH, { accountIds: ["acct-2"] });
    expect(AppChannel.instance.hasOpenStream("acct-1")).toBe(false);
    expect(AppChannel.instance.hasOpenStream("acct-2")).toBe(true);

    await close();
    expect(AppChannel.instance.hasOpenStream("acct-2")).toBe(false);

    // a report that arrives with no connection open is not kept
    await send("POST", DASHBOARD_PRESENCE_PATH, { accountIds: ["acct-2"] });
    expect(AppChannel.instance.hasOpenStream("acct-2")).toBe(false);
  });
});
