import { ERROR_STATUS, type ErrorCode } from "@artifacts/schema";

/** Route handlers throw this; one handler formats it as 03 says. */
export class ApiError extends Error {
  override name = "ApiError";

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }

  get status() {
    return ERROR_STATUS[this.code];
  }
}
