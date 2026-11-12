import type { z } from "zod";
import { SIM_URL } from "../config";
import { SErrorResponse } from "../server/control-schema";

export class SimUnreachableError extends Error {}

export async function simRequest<T extends z.ZodType>(
  path: string,
  schema: T,
  body?: unknown,
): Promise<z.infer<T>> {
  const init: RequestInit = {};
  if (body !== undefined) {
    init.method = "POST";
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(`${SIM_URL}${path}`, init);
  } catch {
    throw new SimUnreachableError(`signal-sim is not running at ${SIM_URL}`);
  }

  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const failure = SErrorResponse.safeParse(json);
    if (failure.success) {
      throw new Error(failure.data.error);
    }

    throw new Error(`${path} returned ${response.status}`);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${path} returned an unexpected body: ${parsed.error.message}`);
  }

  return parsed.data;
}
