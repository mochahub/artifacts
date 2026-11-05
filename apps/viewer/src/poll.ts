import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { ApiFailure } from "./api.ts";
import { live } from "./events.ts";

export type Remote<T> = {
  data: Signal<T | null>;
  error: Signal<ApiFailure | null>;
  /**
   * True from a path change until that path's first answer, good or bad. A plain value read in render,
   * so the first paint after a change never shows the last path's answer as this one's.
   */
  loading: boolean;
  refresh(): Promise<void>;
};

type ErrorBody = { code?: string; message?: string; details?: Record<string, unknown> };

/**
 * Loads a path, then polls it while the tab is visible (06). The browser revalidates with the ETag,
 * so an unchanged answer costs a 304 and no re-render. When the path changes, the last answer stays
 * on screen until the new one lands: a search retyped never empties the list between keystrokes. A
 * failed poll keeps the last good answer too, and says so in `error`.
 */
export function usePoll<T>(path: string | null, everyMs: number): Remote<T> {
  const data = useSignal<T | null>(null);
  const error = useSignal<ApiFailure | null>(null);
  const last = useSignal("");
  const current = useRef(path);
  current.current = path;
  const settled = useRef<string | null>(null);
  const answered = useSignal(0);

  async function refresh() {
    if (!path) return;
    const settle = () => {
      settled.current = path;
      answered.value += 1;
    };
    let response: Response;
    let text: string;
    try {
      response = await fetch(path);
      text = await response.text();
    } catch (failure) {
      if (current.current !== path) return;
      error.value = new ApiFailure(0, "network", "Couldn't reach the server.");
      last.value = "";
      settle();
      throw failure;
    }
    // A slow answer for an old path (a search that's been retyped) must not replace a newer one.
    if (current.current !== path) return;
    if (!response.ok) {
      let body: ErrorBody = {};
      try {
        body = (text ? JSON.parse(text).error : null) ?? {};
      } catch {
        // An error page from a proxy is not JSON; the status is what matters.
      }
      error.value = new ApiFailure(
        response.status,
        body.code ?? "unknown",
        body.message ?? "Something went wrong.",
        body.details,
      );
      // The next good answer must land even if it reads the same as the last one.
      last.value = "";
      settle();
      return;
    }
    error.value = null;
    if (text !== last.value) {
      last.value = text;
      data.value = JSON.parse(text) as T;
    }
    settle();
  }
  useEffect(() => {
    last.value = "";
    error.value = null;
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

  // Read here so an answer re-renders the caller, even one whose text didn't change.
  void answered.value;
  const loading = path !== null && settled.current !== path;
  return { data, error, loading, refresh };
}
