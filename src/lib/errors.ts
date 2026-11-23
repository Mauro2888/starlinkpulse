import type { CommandError, CommandErrorKind } from "@/types/models";
import { tr as t } from "@/i18n";

const KINDS: readonly CommandErrorKind[] = [
  "offline",
  "unsupported",
  "read_only",
  "timeout",
  "invalid_input",
  "keyring",
  "internal",
  "no_api_key",
  "ai_auth",
  "ai_rate_limit",
  "ai_unavailable",
  "ai_refused",
  "ai_invalid_response",
  "insufficient_data",
];

function isKind(v: unknown): v is CommandErrorKind {
  return typeof v === "string" && (KINDS as readonly string[]).includes(v);
}

/** Error thrown by every API wrapper. Structurally a `CommandError`. */
export class ApiError extends Error implements CommandError {
  readonly kind: CommandErrorKind;

  constructor(kind: CommandErrorKind, message: string) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
  }
}

/**
 * Normalizes anything thrown by `invoke` (serialized `CommandError`, plain
 * string, `Error`, JSON string, unknown) into an `ApiError`.
 */
export function normalizeError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  if (typeof err === "string") {
    const trimmed = err.trim();
    if (trimmed.startsWith("{")) {
      try {
        return normalizeError(JSON.parse(trimmed));
      } catch {
        // fall through: not JSON
      }
    }
    return new ApiError("internal", trimmed || t("Unknown error"));
  }

  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const message =
      typeof obj.message === "string" && obj.message ? obj.message : undefined;
    if (isKind(obj.kind)) {
      return new ApiError(obj.kind, message ?? defaultMessage(obj.kind));
    }
    if (typeof obj.kind === "string") {
      // Unknown kind from a newer backend: keep the text, treat as internal.
      return new ApiError("internal", message ?? obj.kind);
    }
    if (err instanceof Error) {
      return new ApiError(guessKind(err.message), err.message || t("Unknown error"));
    }
    if (message) return new ApiError(guessKind(message), message);
  }

  return new ApiError("internal", t("Unknown error"));
}

function guessKind(message: string): CommandErrorKind {
  return /timed? ?out/i.test(message) ? "timeout" : "internal";
}

export function defaultMessage(kind: CommandErrorKind): string {
  switch (kind) {
    case "offline":
      return t("The dish is not reachable.");
    case "unsupported":
      return t("This dish does not support that action.");
    case "read_only":
      return t("Read-only mode is on.");
    case "timeout":
      return t("The dish did not answer in time.");
    case "invalid_input":
      return t("Some values are not valid.");
    case "keyring":
      return t("The system keychain is not available.");
    case "internal":
      return t("Something went wrong.");
    case "no_api_key":
      return t("No Anthropic API key is saved.");
    case "ai_auth":
      return t("Anthropic did not accept the API key.");
    case "ai_rate_limit":
      return t("Anthropic is rate-limiting this API key.");
    case "ai_unavailable":
      return t("The Anthropic API is unavailable right now.");
    case "ai_refused":
      return t("Claude declined to analyze this data.");
    case "ai_invalid_response":
      return t("Claude's reply could not be read.");
    case "insufficient_data":
      return t("Not enough history to analyze yet.");
  }
}

/** Short, user-facing title for a toast. */
export function errorTitle(kind: CommandErrorKind): string {
  switch (kind) {
    case "offline":
      return t("Dish offline");
    case "unsupported":
      return t("Not supported");
    case "read_only":
      return t("Read-only mode");
    case "timeout":
      return t("Timed out");
    case "invalid_input":
      return t("Invalid settings");
    case "keyring":
      return t("Keychain error");
    case "internal":
      return t("Error");
    case "no_api_key":
      return t("No API key");
    case "ai_auth":
      return t("API key rejected");
    case "ai_rate_limit":
      return t("Rate limited");
    case "ai_unavailable":
      return t("Claude unavailable");
    case "ai_refused":
      return t("Request declined");
    case "ai_invalid_response":
      return t("Unreadable reply");
    case "insufficient_data":
      return t("Not enough data");
  }
}
