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
  constructor(message: string, cause?: unknown) {
    super(message, "network_error", null, cause);
    this.name = "NetworkError";
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
