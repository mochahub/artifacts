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

/** Calls the API, re-prompting once if it asks for a recent sign-in. */
export async function api<T>(
  path: string,
  init: { method?: string; json?: unknown; text?: boolean } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.json === undefined ? {} : { "Content-Type": "application/json" },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = (text ? JSON.parse(text) : {}).error ?? {};
    throw new ApiFailure(
      response.status,
      error.code ?? "unknown",
      error.message ?? "Something went wrong.",
      error.details,
    );
  }
  if (init.text) return text as T;
  return (text ? JSON.parse(text) : undefined) as T;
}

export const post = <T>(path: string, json: unknown = {}) => api<T>(path, { method: "POST", json });
export const del = <T>(path: string, json: unknown = {}) => api<T>(path, { method: "DELETE", json });
export const message = (failure: unknown) =>
  failure instanceof ApiFailure ? failure.message : "Something went wrong.";

/**
 * Whether a failure means this address has nothing for you, as opposed to a bad moment (429, 5xx, a 503
 * while the server restarts). Only the first replaces a screen that is already showing something: the
 * polls would otherwise swap an open canvas for "Nothing here" and lose its pan, zoom and draft.
 */
export const isMissing = (failure: ApiFailure | null) =>
  failure !== null && [400, 403, 404, 410].includes(failure.status);
