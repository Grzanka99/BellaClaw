import type { TSchema } from "@earendil-works/pi-ai";
import type { StaticDecode } from "typebox";
import { Value } from "typebox/value";

export function createToolDefinition(name: string, description: string, parameters: TSchema) {
  return {
    name,
    description,
    parameters,
  };
}

export function decodeToolArguments<T extends TSchema>(schema: T, args: unknown): StaticDecode<T> {
  if (Value.Check(schema, args)) {
    return Value.Decode(schema, args);
  }

  const [failure] = Value.Errors(schema, args);
  let location = failure?.instancePath ?? "";

  if (location === "") {
    location = "(root)";
  }

  throw new Error(`Invalid tool arguments: ${location}: ${failure?.message ?? "schema mismatch"}`);
}
