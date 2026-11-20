import { createSystemTurnId, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TGatewayError, TOption } from "@bellaclaw/shared";
import type { z } from "zod";

// every issue of a refused body with its path, for the 400's message
export function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => [...issue.path, issue.message].join(": ")).join(", ");
}

// the trace of a command the API publishes for a chat
export function systemTrace(chatId: string): TBehaviorTraceContext {
  return { turnId: createSystemTurnId(), chatId, platform: undefined };
}

export function errorResponse(error: string, status: number, code: TOption<string>): Response {
  const body: TGatewayError = { error, code };

  return Response.json(body, { status });
}
