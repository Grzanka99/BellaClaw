import { compile, type Schema } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";

export function createToolDefinition(name: string, description: string, parameters: Schema) {
  return {
    name,
    description,
    parameters,
    instructionsPath: `./src/services/ai/tools/${name}/instructions.xml`,
  };
}

export function validateToolArguments<T extends Schema>(schema: T, args: unknown) {
  const validator = compile(schema, { formats });

  if (validator.check(args)) {
    return args;
  }

  const [failure] = validator.errors(args);
  let location = failure?.path ?? "";

  if (location === "") {
    location = "(root)";
  }

  throw new Error(`Invalid tool arguments: ${location}: ${failure?.message ?? "schema mismatch"}`);
}
