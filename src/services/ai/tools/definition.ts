import { type ZodType, z } from "zod";
import type { TToolDefinition } from "../types";

export function createToolDefinition(
  name: string,
  description: string,
  schema: ZodType,
): TToolDefinition {
  const parameters = z.toJSONSchema(schema, { io: "input" });
  delete parameters.$schema;

  return {
    name,
    description,
    parameters,
  };
}
