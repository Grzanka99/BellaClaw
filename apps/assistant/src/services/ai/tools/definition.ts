import type { TSchema } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

export function createToolDefinition(name: string, description: string, parameters: TSchema) {
  return {
    name,
    description,
    parameters,
    instructionsPath: `./src/services/ai/tools/${name}/instructions.xml`,
  };
}

export function validateToolArguments<T extends TSchema>(schema: T, args: unknown) {
  if (Value.Check(schema, args)) {
    return args;
  }

  const [failure] = Value.Errors(schema, args);
  let location = failure?.instancePath ?? "";

  if (location === "") {
    location = "(root)";
  }

  throw new Error(`Invalid tool arguments: ${location}: ${failure?.message ?? "schema mismatch"}`);
}
