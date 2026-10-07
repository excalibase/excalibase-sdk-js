export class ExcalibaseError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly cause: unknown;

  constructor(message: string, code = "unknown", status: number | null = null, cause?: unknown) {
    super(message);
    this.name = "ExcalibaseError";
    this.code = code;
    this.status = status;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AuthError extends ExcalibaseError {
  constructor(message: string, code = "auth_error", status: number | null = null, cause?: unknown) {
    super(message, code, status, cause);
    this.name = "AuthError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NetworkError extends ExcalibaseError {
  constructor(message: string, cause?: unknown, code = "network_error") {
    super(message, code, null, cause);
    this.name = "NetworkError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A browser request that failed the way a CORS refusal does: the page's
 * origin is probably not in the project's allowed origins. `origin` is the
 * page's own origin, the value to add.
 */
export class CorsError extends NetworkError {
  readonly origin: string;

  constructor(origin: string, cause?: unknown) {
    super(
      `Request probably blocked by CORS: this page's origin ${origin} is not allowed by the project. ` +
        `Add ${origin} in Studio → Settings → Allowed origins; a change takes about a minute to apply.`,
      cause,
      "cors_blocked",
    );
    this.name = "CorsError";
    this.origin = origin;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ConfigError extends ExcalibaseError {
  constructor(message: string) {
    super(message, "config_error", null);
    this.name = "ConfigError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
