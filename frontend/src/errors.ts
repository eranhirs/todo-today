export type ApiErrorKind = "network" | "not_found" | "validation" | "conflict" | "server" | "unknown";

function classifyStatus(status: number): ApiErrorKind {
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "validation";
  if (status >= 500) return "server";
  return "unknown";
}

export class ApiError extends Error {
  readonly status: number | null;
  readonly kind: ApiErrorKind;
  readonly detail: string;
  readonly errorCode: string | null;

  constructor(opts: {
    status: number | null;
    kind: ApiErrorKind;
    detail: string;
    errorCode?: string | null;
  }) {
    super(opts.detail);
    this.name = "ApiError";
    this.status = opts.status;
    this.kind = opts.kind;
    this.detail = opts.detail;
    this.errorCode = opts.errorCode ?? null;
  }

  get isNetwork(): boolean { return this.kind === "network"; }
  get isNotFound(): boolean { return this.kind === "not_found"; }
  get isValidation(): boolean { return this.kind === "validation"; }
  get isConflict(): boolean { return this.kind === "conflict"; }
  get isServer(): boolean { return this.kind === "server"; }

  toUserMessage(fallback?: string): string {
    switch (this.kind) {
      case "network":
        return "Unable to reach the server — check your connection";
      case "not_found":
        return this.detail || "The requested resource was not found";
      case "validation":
        return this.detail || "Invalid request data";
      case "conflict":
        return this.detail;
      case "server":
        return "Something went wrong on the server";
      default:
        return fallback ?? this.detail;
    }
  }

  static fromResponse(status: number, detail: string, errorCode?: string | null): ApiError {
    return new ApiError({
      status,
      kind: classifyStatus(status),
      detail,
      errorCode,
    });
  }

  static networkError(cause?: unknown): ApiError {
    const detail = cause instanceof Error ? cause.message : "Network request failed";
    return new ApiError({
      status: null,
      kind: "network",
      detail,
    });
  }
}

/** Extract a user-friendly message from any caught error. */
export function apiErrorMessage(err: unknown, fallback?: string): string {
  if (err instanceof ApiError) return err.toUserMessage(fallback);
  if (err instanceof Error) return err.message;
  return fallback ?? "Unknown error";
}
