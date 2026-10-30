import { detectAgent } from "./agent.ts";
import { CliError } from "./output.ts";
import { VERSION } from "./version.ts";

export type ApiFailure = { status: number; code: string; message: string; details: Record<string, unknown> };

export class ApiCallError extends CliError {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
  }
}

/** A stalled server shouldn't hang the CLI (or an agent waiting on it) forever. */
const timeoutMs = () => Number(process.env.ARTIFACTS_TIMEOUT_MS ?? 60_000);
/** More than any answer the API gives, so a server that never stops can't fill the memory. */
const MAX_BODY = 100 * 1024 * 1024;

async function readBody(response: Response) {
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_BODY) throw new CliError("The server's answer was too big to read.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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
          ...(detectAgent() ? { "Artifacts-Agent": detectAgent() as string } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A redirect would carry the token to wherever it points, so none is followed.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs()),
      });
    } catch (error) {
      throw new CliError(`Can't reach ${this.url}: ${(error as Error).message}`);
    }
    if (response.status === 426)
      throw new CliError("This CLI is too old for the server. Run artifacts upgrade.");
    let text: string;
    try {
      text = await readBody(response);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(`Can't reach ${this.url}: ${(error as Error).message}`);
    }
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
