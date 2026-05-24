import type { ToolDefinitionJson } from "@openrouter/sdk/models";

type TJsonObject = { [key: string]: unknown };

const OPENCODE_GO_UNSUPPORTED_SCHEMA_KEYS = new Set(["oneOf", "anyOf", "allOf", "not"]);
const REMINDER_PAYLOAD_RULE =
  "Reminder payload rule: provide either reminderText or reminderPromptData, not both. If reminderPromptData is set, reminderFallbackText is required.";

function isJsonObject(value: unknown): value is TJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSchemaValue(item));
  }

  if (!isJsonObject(value)) {
    return value;
  }

  const sanitized: TJsonObject = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    if (OPENCODE_GO_UNSUPPORTED_SCHEMA_KEYS.has(key)) {
      continue;
    }

    sanitized[key] = sanitizeSchemaValue(nestedValue);
  }

  return sanitized;
}

function sanitizeToolParameters(parameters: TJsonObject | undefined): TJsonObject {
  if (parameters === undefined) {
    return { type: "object", properties: {} };
  }

  const sanitized = sanitizeSchemaValue(parameters);

  if (isJsonObject(sanitized)) {
    return sanitized;
  }

  return { type: "object", properties: {} };
}

function hasReminderPayloadRule(parameters: TJsonObject | undefined): boolean {
  if (parameters === undefined) {
    return false;
  }

  const properties = parameters.properties;

  if (!isJsonObject(properties)) {
    return false;
  }

  return (
    Array.isArray(parameters.oneOf) &&
    properties.reminderText !== undefined &&
    properties.reminderPromptData !== undefined &&
    properties.reminderFallbackText !== undefined
  );
}

function addReminderPayloadRule(
  description: string | undefined,
  parameters: TJsonObject | undefined,
): string | undefined {
  if (
    description === undefined ||
    !hasReminderPayloadRule(parameters) ||
    description.includes(REMINDER_PAYLOAD_RULE)
  ) {
    return description;
  }

  return `${description} ${REMINDER_PAYLOAD_RULE}`;
}

export function convertToolsForOpencodeGo(tools: ToolDefinitionJson[]): ToolDefinitionJson[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.function.name,
      description: addReminderPayloadRule(tool.function.description, tool.function.parameters),
      parameters: sanitizeToolParameters(tool.function.parameters),
      strict: tool.function.strict,
    },
  }));
}
