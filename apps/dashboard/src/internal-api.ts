import {
  createLogger,
  dashboardChatMessagePath,
  dashboardChatModelPath,
  SDashboardError,
  SDashboardMessageDeleted,
  SDashboardModelState,
  type TDashboardMessageDeleted,
  type TDashboardModelState,
  type TDashboardModelUpdate,
  type TOption,
} from "@bellaclaw/shared";
import type { z } from "zod";

// NOTE: a model change waits for the assistant's provider verification, which can take minutes.
// Just under the 255 s idle timeout of both servers, so the caller gets an answer.
const INTERNAL_API_TIMEOUT_MS = 250_000;
const UNAVAILABLE = "The assistant is unavailable";

const logger = createLogger("INTERNAL-API");

// status 400 and 404 carry the assistant's own error; 502 is an unreachable or broken assistant
export type TInternalApiResult<T> = { data: T } | { error: string; status: 400 | 404 | 502 };

export type TInternalApi = {
  getModel(chatId: string): Promise<TInternalApiResult<TDashboardModelState>>;
  updateModel(
    chatId: string,
    update: TDashboardModelUpdate,
  ): Promise<TInternalApiResult<TDashboardModelState>>;
  deleteMessage(
    chatId: string,
    messageId: number,
  ): Promise<TInternalApiResult<TDashboardMessageDeleted>>;
};

// The assistant's internal API. baseUrl has no trailing slash.
export function createInternalApi(baseUrl: string, secret: string): TInternalApi {
  async function call<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body: TOption<TDashboardModelUpdate>,
  ): Promise<TInternalApiResult<T>> {
    let status: number;
    let payload: unknown;

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(INTERNAL_API_TIMEOUT_MS),
      });
      status = response.status;
      payload = await response.json();
    } catch (error) {
      logger.error(`${method} request failed: ${error}`);

      return { error: UNAVAILABLE, status: 502 };
    }

    if (status === 200) {
      const data = schema.safeParse(payload);

      if (data.success) {
        return { data: data.data };
      }
    }

    if (status === 400 || status === 404) {
      const failure = SDashboardError.safeParse(payload);

      if (failure.success) {
        return { error: failure.data.error, status };
      }
    }

    logger.error(`${method} request answered ${status} with an unexpected body`);

    return { error: UNAVAILABLE, status: 502 };
  }

  return {
    getModel: (chatId) =>
      call("GET", dashboardChatModelPath(chatId), SDashboardModelState, undefined),
    updateModel: (chatId, update) =>
      call("PUT", dashboardChatModelPath(chatId), SDashboardModelState, update),
    deleteMessage: (chatId, messageId) =>
      call(
        "DELETE",
        dashboardChatMessagePath(chatId, messageId),
        SDashboardMessageDeleted,
        undefined,
      ),
  };
}
