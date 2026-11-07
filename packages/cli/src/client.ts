import { type ApiErrorBody, EDITING_FEATURE, FEATURES_HEADER } from "@artifacts/schema";
import { detectAgent } from "./agent.ts";
import { requireHttps } from "./config.ts";
import { CliError } from "./output.ts";
import { VERSION } from "./version.ts";

/** The server's error body (03), with the status it came with. */
export type ApiFailure = ApiErrorBody["error"] & { status: number };

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

  /** Whatever built this client, nothing goes to a plain http server that isn't this machine. */
  private send(path: string, init: { method?: string; body?: string; json?: boolean } = {}) {
    requireHttps(this.url);
    const agent = detectAgent();
    return fetch(`${this.url}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "Artifacts-CLI": VERSION,
        // This CLI knows the editing values (13, "Older clients"): without it the server answers as it did before them.
        [FEATURES_HEADER]: EDITING_FEATURE,
        ...(agent ? { "Artifacts-Agent": agent } : {}),
        ...(init.json ? { "Content-Type": "application/json" } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: init.body,
      // A redirect would carry the token to wherever it points, so none is followed.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs()),
    }).catch((error) => {
      throw new CliError(`Can't reach ${this.url}: ${(error as Error).message}`);
    });
  }

  /** The answer's body as text, or the failure the server gave. */
  private async fetchText(method: string, path: string, body?: unknown): Promise<string> {
    const response = await this.send(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      json: body !== undefined,
    });
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
        const { error } = JSON.parse(text) as ApiErrorBody;
        failure = { status: response.status, ...error };
      } catch {}
      throw new ApiCallError(failure);
    }
    return text;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const text = await this.fetchText(method, path, body);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** A route that answers text, such as a page's Markdown. */
  text = (path: string) => this.fetchText("GET", path);

  /** A picture from the API, as bytes. A redirect isn't followed, as everywhere, so it counts as a failure. */
  async bytes(path: string): Promise<Uint8Array> {
    const response = await this.send(path);
    if (response.status !== 200)
      throw new CliError(`The server answered ${response.status} for that picture.`);
    return new Uint8Array(await response.arrayBuffer());
  }

  get = <T>(path: string) => this.request<T>("GET", path);
  post = <T>(path: string, body?: unknown) => this.request<T>("POST", path, body ?? {});
}
