import type { Artifact, ContentToken, DataScope } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { message, post } from "../api.ts";
import type { Infer } from "../types.ts";
import { startBridge } from "./bridge.ts";

type Props = {
  artifact: Artifact;
  version: number;
  path: string;
  width?: number;
  height?: number;
  onUse?(scope: DataScope): void;
};

/** A live page in its sandbox: only allow-scripts, never allow-same-origin (04). */
export function LiveFrame({ artifact, version, path, width, height, onUse }: Props) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const src = useSignal<string | null>(null);
  const error = useSignal<string | null>(null);
  // Read when a frame first saves, so a new callback each render doesn't restart the bridge.
  const used = useRef(onUse);
  used.current = onUse;

  useEffect(() => {
    post<Infer<typeof ContentToken>>(`/api/artifacts/${artifact.id}/content-token`, { version })
      .then(({ base }) => {
        src.value = `${base}${path.split("/").map(encodeURIComponent).join("/")}`;
      })
      .catch((failure) => {
        error.value = message(failure, "Live previews aren't available.");
      });
  }, [artifact.id, version, path, src, error]);

  // Before paint: a cached page can run and post while a plain effect is still waiting, and a request
  // nobody heard is never answered.
  useLayoutEffect(() => {
    if (!iframe.current || !src.value) return;
    return startBridge({
      iframe: iframe.current,
      artifactId: artifact.id,
      canWrite: artifact.permissions.comment,
      onUse: (scope) => used.current?.(scope),
    });
  }, [src.value, artifact.id, artifact.permissions.comment]);

  if (error.value) return <p class="err">{error.value}</p>;
  if (!src.value) return null;
  return (
    <iframe
      ref={iframe}
      class="live"
      title="Live preview"
      sandbox="allow-scripts"
      allow="fullscreen"
      referrerpolicy="no-referrer"
      src={src.value}
      style={{ width: width ? `${width}px` : "100%", height: height ? `${height}px` : "100%" }}
    />
  );
}

/** Where a frame's saves go, once it first saves or reads. */
export function SavedNotice({ scope, place }: { scope: DataScope | null; place: "hint" | "notice" }) {
  if (!scope) return null;
  return (
    <div class={`${place} glass`}>
      {scope === "shared" ? "Saved for everyone" : "Saved for you"}. Its author can see what's saved.
    </div>
  );
}
