import type { Thread } from "@artifacts/schema";
import type { BoardObject } from "@artifacts/schema/boards";
import { anchorPoint, type Scene } from "./geometry.ts";

/** Legacy frame keys are page scoped; the rendered source retains that identity after placement. */
export function threadPoint(scene: Scene, thread: Thread) {
  if (thread.anchorState === "orphaned") return null;
  const anchor = thread.anchor;
  if (anchor?.type === "object") {
    const object = scene.objects.get(anchor.object);
    const at = anchorPoint(scene, anchor.object, anchor.u, anchor.v);
    return object && at ? { object, at, u: anchor.u, v: anchor.v } : null;
  }
  if (anchor?.type !== "frame") return null;
  const object = scene.order.find(
    (entry) =>
      entry.kind === "rendered_frame" &&
      entry.data.source.page === thread.pageKey &&
      entry.data.source.frame === anchor.frameKey,
  );
  const at = object && anchorPoint(scene, object.id, anchor.x, anchor.y);
  return object && at ? { object, at, u: anchor.x, v: anchor.y } : null;
}

export function commentAnchor(object: BoardObject, u: number, v: number, checkpoint: number) {
  return object.kind === "rendered_frame"
    ? { type: "frame" as const, frameKey: object.data.source.frame, x: u, y: v }
    : { type: "object" as const, object: object.id, u, v, checkpoint };
}
