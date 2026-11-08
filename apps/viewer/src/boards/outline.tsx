import type { BoardObject } from "@artifacts/schema/boards";
import { Sheet } from "../components/sheet.tsx";
import { kindWord, objectName, objectText, type Scene } from "./geometry.ts";
import { type AuthorInfo, mainAuthor } from "./render.ts";

/**
 * The Objects outline (14, "Viewer"): every object in stable traversal order, with its kind, what it
 * says, its group and what an arrow joins, and who made it. Selecting one shows it on the board; an
 * editor can edit or move it from here, without a drag.
 */
function depthOf(scene: Scene, object: BoardObject) {
  let depth = 0;
  let parent = object.parent;
  while (parent && depth < 8) {
    depth++;
    parent = scene.objects.get(parent)?.parent ?? null;
  }
  return depth;
}

export function describeObject(scene: Scene, object: BoardObject) {
  if (object.kind !== "connector") {
    const group = object.parent ? scene.objects.get(object.parent) : null;
    return group ? `in ${group.label || "a frame"}` : "";
  }
  const end = (binding: { object: string } | null) => {
    const target = binding && scene.objects.get(binding.object);
    return target ? objectName(target) : "a point";
  };
  return `from ${end(object.data.start.binding)} to ${end(object.data.end.binding)}`;
}

export function Outline({
  scene,
  author,
  selected,
  title = "Objects",
  onPick,
  onClose,
  children,
}: {
  scene: Scene;
  author(key: string): AuthorInfo | null;
  selected?: string | null;
  title?: string;
  onPick(id: string): void;
  onClose(): void;
  children?: preact.ComponentChildren;
}) {
  return (
    <Sheet title={title} onClose={onClose}>
      {children}
      {scene.order.length === 0 ? (
        <p class="ss">Nothing on this board yet.</p>
      ) : (
        <ul class="group" aria-label="Objects on this board">
          {scene.order.map((object) => {
            const who = author(mainAuthor(object));
            const text = objectText(object).replace(/\s+/g, " ").trim();
            const more = describeObject(scene, object);
            return (
              <li key={object.id}>
                <button
                  type="button"
                  class={`li btn-li ol-row${selected === object.id ? " on" : ""}`}
                  aria-current={selected === object.id ? "true" : undefined}
                  style={{ paddingLeft: `${16 + depthOf(scene, object) * 16}px` }}
                  onClick={() => onPick(object.id)}
                >
                  <span class="kd">{kindWord(object)}</span>
                  <span class="grow">
                    <span class="tt">{text || (object.kind === "connector" ? "Arrow" : "No text")}</span>
                    {more && <span class="ss"> {more}</span>}
                  </span>
                  {who && (
                    <span class={`who-t${who.kind === "agent" ? " agent" : ""}`}>
                      {who.kind === "agent" ? `✎ ${who.name}` : who.name}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
