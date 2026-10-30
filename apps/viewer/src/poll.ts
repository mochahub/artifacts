import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { ApiFailure } from "./api.ts";
import { live } from "./events.ts";

export type Remote<T> = {
  data: Signal<T | null>;
  error: Signal<ApiFailure | null>;
  refresh(): Promise<void>;
};

/**
 * Loads a path, then polls it while the tab is visible (06). The browser revalidates with the ETag,
 * so an unchanged answer costs a 304 and no re-render.
 */
export function usePoll<T>(path: string | null, everyMs: number): Remote<T> {
  const data = useSignal<T | null>(null);
  const error = useSignal<ApiFailure | null>(null);
  const last = useSignal("");
  const current = useRef(path);
  current.current = path;

  async function refresh() {
    if (!path) return;
    const response = await fetch(path);
    const text = await response.text();
    // A slow answer for an old path (a search that's been retyped) must not replace a newer one.
    if (current.current !== path) return;
    if (!response.ok) {
      const body = text ? JSON.parse(text).error : {};
      error.value = new ApiFailure(
        response.status,
        body.code ?? "unknown",
        body.message ?? "Something went wrong.",
        body.details,
      );
      return;
    }
    error.value = null;
    if (text !== last.value) {
      last.value = text;
      data.value = JSON.parse(text) as T;
    }
  }
  useEffect(() => {
    data.value = null;
    last.value = "";
    refresh().catch(() => {});
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      // With a stream open, fast polls drop to one a minute: a safety net for an event that got lost.
      if (live.value && everyMs < 60_000 && (ticks * everyMs) % 60_000 !== 0) return;
      if (document.visibilityState === "visible") refresh().catch(() => {});
    }, everyMs);
    return () => clearInterval(timer);
  }, [path, everyMs]);

  return { data, error, refresh };
}
