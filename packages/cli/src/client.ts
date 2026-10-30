import { CliError } from "./output.ts";
import { VERSION } from "./version.ts";

export type ApiFailure = { status: number; code: string; message: string; details: Record<string, unknown> };

export class ApiCallError extends CliError {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
  }
}

/** The server's API, as this CLI version and (optionally) a token. */
export class Client {
  constructor(
    readonly url: string,
    readonly token: string | null = null,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method,
        headers: {
          "Artifacts-CLI": VERSION,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
    } catch (error) {
      throw new CliError(`Can't reach ${this.url}: ${(error as Error).message}`);
    }
    if (response.status === 426)
      throw new CliError("This CLI is too old for the server. Run artifacts upgrade.");
    const text = await response.text();
    if (!response.ok) {
      let failure: ApiFailure = {
        status: response.status,
        code: "unknown",
        message: `The server answered ${response.status}.`,
        details: {},
      };
      try {
        const { error } = JSON.parse(text) as { error: Omit<ApiFailure, "status"> };
        failure = { status: response.status, ...error };
      } catch {}
      throw new ApiCallError(failure);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get = <T>(path: string) => this.request<T>("GET", path);
  post = <T>(path: string, body?: unknown) => this.request<T>("POST", path, body ?? {});
}
