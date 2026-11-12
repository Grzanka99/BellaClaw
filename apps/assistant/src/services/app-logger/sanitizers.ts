import type { TBehaviorMetadata } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";

/**
 * A field whose value may be logged as-is. A tuple logs it under another metadata key.
 */
export type TLogSafeField = string | readonly [field: string, logKey: string];

export type TToolLogPolicy = {
  logSafe: ReadonlyArray<TLogSafeField>;
  /** Error text can quote private values, so only ToolError codes are logged. */
  privateErrors: boolean;
  /** String fields also logged as a bounded, secret-redacted `<key>Preview`. */
  previews?: ReadonlyArray<string>;
};

type TNormalizedToolResult = {
  toolCallId: string;
  toolName: string;
  success: boolean;
  data: TOption<unknown>;
  error: TOption<string>;
};

type TSanitizedLogDetails = {
  summary: string;
  metadata: TBehaviorMetadata;
};

const ERROR_MAX_CHARS = 300;
const PREVIEW_MAX_CHARS = 240;

export function sanitizeErrorMessage(error: TOption<string>): TOption<string> {
  if (error === undefined) {
    return undefined;
  }

  const redacted = redactSecrets(error);
  const normalized = redacted.replace(/\s+/g, " ").trim();
  const directHttpStatus = normalized.match(/^([1-5]\d{2})(?:\b|:)/);

  if (directHttpStatus !== null) {
    return `Provider error status=${directHttpStatus[1]}`;
  }

  const namedHttpStatus = normalized.match(/^[^:]{1,80}\(([1-5]\d{2})\):/);

  if (namedHttpStatus !== null) {
    return `Provider error status=${namedHttpStatus[1]}`;
  }

  if (normalized.length <= ERROR_MAX_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, ERROR_MAX_CHARS)}...`;
}

export function sanitizeToolCallArguments(
  toolName: string,
  args: unknown,
  policy: TOption<TToolLogPolicy>,
): TSanitizedLogDetails {
  if (!isRecord(args)) {
    return {
      summary: `${toolName} args invalid`,
      metadata: {
        argumentsKind: describeDataKind(args),
      },
    };
  }

  const metadata = summarizeShape(args, policy?.logSafe ?? []);
  const summary = `${toolName} args${formatSummary(metadata)}`;
  addPreviews(metadata, args, policy?.previews ?? []);

  return { summary, metadata };
}

export function sanitizeToolResult(
  result: TNormalizedToolResult,
  policy: TOption<TToolLogPolicy>,
): TSanitizedLogDetails {
  if (!result.success) {
    return {
      summary: `${result.toolName} failed`,
      metadata: {
        status: "failed",
      },
    };
  }

  const metadata: TBehaviorMetadata = { status: "completed" };

  if (Array.isArray(result.data)) {
    metadata.resultCount = result.data.length;
  } else if (isRecord(result.data)) {
    Object.assign(metadata, summarizeShape(result.data, policy?.logSafe ?? []));
  } else {
    metadata.dataKind = describeDataKind(result.data);
  }

  const summary = `${result.toolName} completed${formatSummary(metadata)}`;

  if (isRecord(result.data)) {
    addPreviews(metadata, result.data, policy?.previews ?? []);
  }

  return { summary, metadata };
}

export function sanitizeToolResultError(
  result: TNormalizedToolResult,
  policy: TOption<TToolLogPolicy>,
): TOption<string> {
  if (result.error === undefined) {
    return undefined;
  }

  if (policy === undefined) {
    return sanitizeErrorMessage(result.error);
  }

  if (isRecord(result.data) && typeof result.data.errorCode === "string") {
    return `${result.toolName} failed: ${result.data.errorCode}`;
  }

  if (policy.privateErrors) {
    return `${result.toolName} failed`;
  }

  return sanitizeErrorMessage(result.error);
}

/**
 * Logs a record's shape, never its content: strings become `<key>Chars`, arrays `<key>Count`.
 * Only `logSafe` fields keep their value; a safe nested record logs its keys.
 */
function summarizeShape(
  record: Record<string, unknown>,
  logSafe: ReadonlyArray<TLogSafeField>,
): TBehaviorMetadata {
  const metadata: TBehaviorMetadata = {};

  for (const [key, value] of Object.entries(record)) {
    let logKey: TOption<string>;

    for (const field of logSafe) {
      if (field === key) {
        logKey = key;
      } else if (typeof field !== "string" && field[0] === key) {
        logKey = field[1];
      }
    }

    if (Array.isArray(value)) {
      metadata[`${key}Count`] = value.length;
      continue;
    }

    if (logKey === undefined) {
      if (typeof value === "string") {
        metadata[`${key}Chars`] = value.length;
      }

      continue;
    }

    if (typeof value === "string" || typeof value === "boolean") {
      metadata[logKey] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      metadata[logKey] = value;
    } else if (value instanceof Date) {
      metadata[logKey] = value.toISOString();
    } else if (isRecord(value)) {
      metadata[logKey] = Object.keys(value);
    }
  }

  return metadata;
}

/** Adds `<key>Preview` for the tool's preview fields; kept out of the one-line summary. */
function addPreviews(
  metadata: TBehaviorMetadata,
  record: Record<string, unknown>,
  previews: ReadonlyArray<string>,
) {
  for (const key of previews) {
    const value = record[key];

    if (typeof value !== "string") {
      continue;
    }

    const preview = redactSecrets(value).replace(/\s+/g, " ").trim();

    if (preview.length <= PREVIEW_MAX_CHARS) {
      metadata[`${key}Preview`] = preview;
    } else {
      metadata[`${key}Preview`] = `${preview.slice(0, PREVIEW_MAX_CHARS)}...`;
    }
  }
}

function formatSummary(metadata: TBehaviorMetadata): string {
  let summary = "";

  for (const [key, value] of Object.entries(metadata)) {
    if (key === "status") {
      continue;
    }

    if (Array.isArray(value)) {
      summary += ` ${key}=${value.join(",")}`;
    } else {
      summary += ` ${key}=${String(value)}`;
    }
  }

  return summary;
}

const registeredSecrets = new Set<string>();

export function registerRedactedSecret(secret: string) {
  registeredSecrets.add(secret);
}

function redactSecrets(value: string): string {
  let redacted = value;
  // Longest first, so a secret that contains another one is masked whole.
  const secrets = [Bun.env.OPENROUTER_API_KEY, ...registeredSecrets].toSorted(
    (left, right) => (right?.length ?? 0) - (left?.length ?? 0),
  );

  for (const secret of secrets) {
    if (secret !== undefined && secret.length > 0) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
  }

  return redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeDataKind(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }

  if (value === null) {
    return "null";
  }

  return typeof value;
}
