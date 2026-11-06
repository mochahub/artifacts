import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { ApiFailure, parseJson, readText } from "./api.ts";
import { live } from "./events.ts";

export type Remote<T> = {
  data: Signal<T | null>;
  error: Signal<ApiFailure | null>;
  /**
   * True from a path change until that path's first answer, good or bad. A plain value read in render,
   * so the first paint after a change never shows the last path's answer as this one's.
   */
  loading: boolean;
  /** Asks again. Never rejects: a failure lands in `error`. */
  refresh(): Promise<void>;
};

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
    try {
      const response = await fetch(path);
      const text = await readText(response);
      // A slow answer for an old path (a search that's been retyped) must not replace a newer one.
      if (current.current !== path) return;
      if (text !== last.value) {
        data.value = parseJson<T>(response.status, text);
        last.value = text;
      }
      error.value = null;
    } catch (failure) {
      if (current.current !== path) return;
      // Anything but an answer from the API is the network: fetch failing, or the body cut off.
      error.value =
        failure instanceof ApiFailure ? failure : new ApiFailure(0, "network", "Couldn't reach the server.");
      // The next good answer must land even if it reads the same as the last one.
      last.value = "";
    }
    settled.current = path;
    answered.value += 1;
  }
  useEffect(() => {
    last.value = "";
    error.value = null;
    refresh();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      // With a stream open, fast polls drop to one a minute: a safety net for an event that got lost.
      if (live.value && everyMs < 60_000 && (ticks * everyMs) % 60_000 !== 0) return;
      if (document.visibilityState === "visible") refresh();
    }, everyMs);
    return () => clearInterval(timer);
  }, [path, everyMs]);

  // Read here so an answer re-renders the caller, even one whose text didn't change.
  void answered.value;
  const loading = path !== null && settled.current !== path;
  return { data, error, loading, refresh };
}
