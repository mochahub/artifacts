import { BridgeRequest } from "@artifacts/schema";
import { ApiFailure, api } from "../api.ts";
import { me } from "../session.ts";

const MAX_IN_FLIGHT = 8;
const CODES = new Set([
  "precondition_failed",
  "read_only",
  "too_large",
  "forbidden",
  "not_found",
  "rate_limited",
  "invalid",
]);

type Options = {
  iframe: HTMLIFrameElement;
  artifactId: string;
  canWrite: boolean;
  /** The first time a frame saves or reads, so the viewer can say where it goes. */
  onUse?(scope: "shared" | "me"): void;
};

const path = (encoded: string) => encoded.split("/").map(encodeURIComponent).join("/");

/**
 * The viewer's side of the bridge (08). The artifact id comes from the iframe this viewer made, never
 * from the message, and only that iframe's window is listened to.
 */
export function startBridge({ iframe, artifactId, canWrite, onUse }: Options) {
  let inFlight = 0;
  const base = `/api/artifacts/${artifactId}`;

  async function run(op: BridgeRequest["op"]): Promise<unknown> {
    if (op.kind === "whoami")
      return { name: me.value?.name ?? "Guest", kind: me.value?.role ?? "guest", canWrite };
    onUse?.(op.scope);
    const data = `${base}/data/${op.scope}`;
    const files = `${base}/files/${op.scope}`;
    switch (op.kind) {
      case "get":
        return api(`${data}/${path(op.key)}`);
      case "list":
        return api(`${data}?${new URLSearchParams({ prefix: op.prefix ?? "", cursor: op.cursor ?? "" })}`);
      case "put": {
        const headers: Record<string, string> =
          op.ifMatch === "*" ? { "If-None-Match": "*" } : op.ifMatch ? { "If-Match": op.ifMatch } : {};
        return send(
          `${data}/${path(op.key)}`,
          "PUT",
          { ...headers, "Content-Type": "application/json" },
          JSON.stringify({ value: op.value }),
        );
      }
      case "delete":
        return send(`${data}/${path(op.key)}`, "DELETE", op.ifMatch ? { "If-Match": op.ifMatch } : {});
      case "file.put":
        return send(
          `${files}/${path(op.name)}`,
          "PUT",
          { "Content-Type": op.blob.type || "application/octet-stream" },
          op.blob,
        );
      case "file.url": {
        const { url } = await send<{ url: string }>(`${files}/${path(op.name)}`, "GET", {
          Accept: "application/json",
        });
        return url;
      }
      case "file.list":
        return api(files);
      case "file.delete":
        return send(`${files}/${path(op.name)}`, "DELETE");
    }
  }

  async function send<T>(
    url: string,
    method: string,
    headers: Record<string, string> = {},
    body?: BodyInit,
  ): Promise<T> {
    const response = await fetch(url, { method, headers, body });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      throw new ApiFailure(
        response.status,
        parsed?.error?.code ?? "invalid",
        parsed?.error?.message ?? "That didn't work.",
      );
    }
    return parsed as T;
  }

  const onMessage = async (event: MessageEvent) => {
    // The source check is what matters: an opaque frame's origin is just "null" (08). A message from a
    // window that has since closed has no source, and a detached iframe has no contentWindow: null
    // equals null, so that case is refused outright.
    if (!event.source || event.source !== iframe.contentWindow || event.data?.artifacts !== 1) return;
    const target = event.source as Window;
    const parsed = BridgeRequest.safeParse(event.data);
    if (!parsed.success) {
      // Answered, so a bad key fails in the frame instead of waiting forever.
      const error = { code: "invalid", message: "That isn't a valid request." };
      if (typeof event.data.id === "string")
        target.postMessage({ artifacts: 1, id: event.data.id, ok: false, error }, "*");
      return;
    }
    const { id, op } = parsed.data;
    const reply = (body: object) => target.postMessage({ artifacts: 1, id, ...body }, "*");
    if (inFlight >= MAX_IN_FLIGHT) {
      return reply({ ok: false, error: { code: "rate_limited", message: "Too many requests at once." } });
    }
    inFlight += 1;
    try {
      reply({ ok: true, result: await run(op) });
    } catch (failure) {
      const code = failure instanceof ApiFailure && CODES.has(failure.code) ? failure.code : "invalid";
      reply({
        ok: false,
        error: { code, message: failure instanceof Error ? failure.message : "That didn't work." },
      });
    } finally {
      inFlight -= 1;
    }
  };

  addEventListener("message", onMessage);
  return () => removeEventListener("message", onMessage);
}
