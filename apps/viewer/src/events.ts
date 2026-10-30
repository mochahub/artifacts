import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";

/** True while a stream is open: the fast polls then only run as a slow safety net (06). */
export const live = signal(false);

const TYPES = ["thread", "comment", "version", "decision", "data"];

/** Refreshes on every change to this artifact. EventSource reconnects by itself, and that rechecks access. */
export function useEvents(artifactId: string | null | undefined, onChange: (type: string) => void) {
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    if (!artifactId || typeof EventSource === "undefined") return;
    const source = new EventSource(`/api/events?artifact=${artifactId}`);
    source.onopen = () => {
      live.value = true;
    };
    source.onerror = () => {
      live.value = false;
    };
    for (const type of TYPES) source.addEventListener(type, () => callback.current(type));
    return () => {
      source.close();
      live.value = false;
    };
  }, [artifactId]);
}
