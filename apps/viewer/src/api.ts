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
