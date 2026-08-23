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

/**
 * Value.Decode throws a bare `Error: Decode` with no path and no reason, and Pi hands that
 * message straight back to the model as the tool result. The model cannot tell which field it
 * got wrong, so it reissues the identical call and burns the tool for the whole turn. Report the
 * failing path instead.
 */
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
