import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";

/** True while a stream is open: the fast polls then only run as a slow safety net (06). */
export const live = signal(false);

const TYPES = ["thread", "comment", "version", "decision", "data"];

/**
 * Opens the stream for one artifact. EventSource reconnects by itself, and that rechecks access, but
 * it doesn't replay what happened while it was away. With a stream open the polls slow to a minute,
 * so each reconnect asks for a refresh itself, as "reconnect".
 */
export function watchEvents(
  artifactId: string,
  onChange: (type: string) => void,
  Source: typeof EventSource = EventSource,
) {
  const source = new Source(`/api/events?artifact=${encodeURIComponent(artifactId)}`);
  let opened = false;
  source.onopen = () => {
    live.value = true;
    if (opened) onChange("reconnect");
    opened = true;
  };
  source.onerror = () => {
    live.value = false;
  };
  for (const type of TYPES) source.addEventListener(type, () => onChange(type));
  return () => {
    source.close();
    live.value = false;
  };
}

/** Refreshes on every change to this artifact. */
export function useEvents(artifactId: string | null | undefined, onChange: (type: string) => void) {
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    if (!artifactId || typeof EventSource === "undefined") return;
    return watchEvents(artifactId, (type) => callback.current(type));
  }, [artifactId]);
}
