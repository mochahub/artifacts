import type { ApiErrorBody } from "@artifacts/schema";

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const FALLBACK = "Something went wrong.";

/** The failure an error answer describes. A proxy's error page isn't JSON, and then the status is what's left. */
function failureOf(status: number, text: string) {
  let error: Partial<ApiErrorBody["error"]> = {};
  try {
    error = (text ? JSON.parse(text).error : null) ?? {};
  } catch {}
  return new ApiFailure(status, error.code ?? "unknown", error.message ?? FALLBACK, error.details);
}

/** A good answer's text, or the failure an error answer describes. */
export async function readText(response: Response): Promise<string> {
  const text = await response.text();
  if (!response.ok) throw failureOf(response.status, text);
  return text;
}

/** A good answer's JSON. An answer that isn't JSON fails like any other, rather than as a SyntaxError. */
export function parseJson<T>(status: number, text: string): T {
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiFailure(status, "unknown", FALLBACK);
  }
}

type Init = {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  /** The answer's text, unparsed. */
  text?: boolean;
};

export async function api<T>(path: string, init: Init = {}): Promise<T> {
  const json = init.json !== undefined;
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: { ...(json ? { "Content-Type": "application/json" } : {}), ...init.headers },
    body: json ? JSON.stringify(init.json) : init.body,
  });
  const text = await readText(response);
  return init.text ? (text as T) : parseJson<T>(response.status, text);
}

export const post = <T>(path: string, json: unknown = {}) => api<T>(path, { method: "POST", json });
export const del = <T>(path: string, json?: unknown) => api<T>(path, { method: "DELETE", json });

/** What to tell someone: the API's own words, or `fallback` for anything else (a network error, a passkey prompt). */
export const message = (failure: unknown, fallback = FALLBACK) =>
  failure instanceof ApiFailure ? failure.message : fallback;

/**
 * Whether a failure means this address has nothing for you, as opposed to a bad moment (429, 5xx, a 503
 * while the server restarts). Only the first replaces a screen that is already showing something: the
 * polls would otherwise swap an open canvas for "Nothing here" and lose its pan, zoom and draft.
 */
export const isMissing = (failure: ApiFailure | null) =>
  failure !== null && [400, 403, 404, 410].includes(failure.status);
