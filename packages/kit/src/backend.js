// For an artifact's backend: who is asking. The app sets X-Caller and removes any a client sent (08).
export function caller(request) {
  return JSON.parse(request.headers.get("x-caller") ?? "null");
}
