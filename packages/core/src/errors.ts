import { ZodError } from "zod";

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function invariant(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new DomainError(code, message);
}

export function errorResponse(error: unknown) {
  if (error instanceof DomainError)
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  if (error instanceof ZodError)
    return {
      code: "validation_error",
      message: "Input does not match schema",
      retryable: false,
      details: error.issues.map((i) => ({ path: i.path, message: i.message })),
    };
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
  if (
    code &&
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "57P01",
      "57P02",
      "57P03",
    ].includes(code)
  )
    return {
      code: "connection_unavailable",
      message:
        "Connection unavailable. Check service availability and configured environment references.",
      retryable: true,
    };
  if (code && ["ENOSPC", "SQLITE_FULL", "53100"].includes(code))
    return {
      code: "storage_full",
      message:
        "Storage is full. Free space in the configured data/evidence location before retrying.",
      retryable: true,
    };
  if (code && ["EACCES", "EPERM", "SQLITE_READONLY", "42501"].includes(code))
    return {
      code: "access_denied",
      message:
        "Configured storage or service permissions do not allow this operation.",
      retryable: false,
    };
  // Driver/network errors can contain full URLs, SQL payloads and credentials.
  return {
    code: "operation_failed",
    message: "Operation failed. Check configuration and resource availability.",
    retryable: true,
  };
}
