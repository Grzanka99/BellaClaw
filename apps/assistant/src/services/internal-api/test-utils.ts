import { afterEach, beforeEach } from "bun:test";
import { resetEventTables, resetIdentityLinksTable } from "../database/test-utils";
import { EventBus } from "../events";
import { handleInternalApiRequest } from ".";

export const TEST_SECRET = "internal-secret";

// a request to the internal API as the gateway sends it, with the secret
export function internalRequest(
  method: string,
  path: string,
  body?: RequestInit["body"],
  headers: Record<string, string> = {},
) {
  return handleInternalApiRequest(
    new Request(`http://internal${path}`, {
      method,
      headers: { Authorization: `Bearer ${TEST_SECRET}`, ...headers },
      body,
    }),
    TEST_SECRET,
  );
}

// a fresh instance of each service and empty event and identity link tables for every test; the
// bus settles and stops after it
export function resetServices(services: object[]) {
  function reset() {
    for (const service of services) {
      Object.assign(service, { _instance: undefined });
    }
  }

  beforeEach(async () => {
    reset();
    await resetEventTables();
    await resetIdentityLinksTable();
  });

  afterEach(async () => {
    await EventBus.instance.idle();
    await EventBus.instance.stop();
    await resetIdentityLinksTable();
    reset();
  });
}
