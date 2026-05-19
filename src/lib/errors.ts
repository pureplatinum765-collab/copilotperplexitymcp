/**
 * Typed errors used across the GitHub auth + adapter + tool layers.
 *
 * The Express error handler in `server.ts` inspects `status` to choose the
 * HTTP response code; everything else falls back to 500. Keep the public
 * `message` safe to surface to API clients — never include tokens.
 */

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class AuthError extends AppError {
  constructor(message: string, details?: unknown) {
    super(401, 'auth_error', message, details);
  }
}

export class ConfigError extends AppError {
  constructor(message: string, details?: unknown) {
    super(500, 'config_error', message, details);
  }
}

export class UpstreamError extends AppError {
  constructor(status: number, message: string, details?: unknown) {
    super(status, 'upstream_error', message, details);
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message: string, details?: unknown) {
    super(429, 'rate_limited', message, details);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super(404, 'not_found', message, details);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'validation_error', message, details);
  }
}
