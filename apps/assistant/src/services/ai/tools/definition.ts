import type { TSchema } from "@earendil-works/pi-ai";

export function createToolDefinition(name: string, description: string, parameters: TSchema) {
  return {
    name,
    description,
    parameters,
  };
}
