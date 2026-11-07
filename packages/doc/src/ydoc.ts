import { createHash } from "node:crypto";
import { ATOM_KINDS, EDIT_BLOCKS_MAX, SHA256_HEX } from "@artifacts/schema/constants";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import { normalizedText } from "./attribution.ts";
import { idRepairs, mintBlockId } from "./ids.ts";
import { editorSchema, type ProseMirrorJSON, safeHref, TOP_BLOCKS } from "./schema.ts";

/** The name of the XmlFragment that holds the page in every draft's Y.Doc. */
export const FRAGMENT = "doc";

/** Origins of server-side transactions, so observers can tell them from a client's update. */
export const SERVER_ORIGIN = "server";

export function docToY(doc: ProseMirrorJSON): Y.Doc {
  return prosemirrorJSONToYDoc(editorSchema, doc, FRAGMENT);
}

export function yToDoc(ydoc: Y.Doc): ProseMirrorJSON {
  return yDocToProsemirrorJSON(ydoc, FRAGMENT) as ProseMirrorJSON;
}

/** One top-level element as JSON, for checks and for `page_read`. */
export function elementToJSON(el: Y.XmlElement): ProseMirrorJSON {
  const fragment = new Y.Doc().getXmlFragment("one");
  fragment.insert(0, [el.clone()]);
  return (yXmlFragmentToProsemirrorJSON(fragment) as ProseMirrorJSON).content?.[0] as ProseMirrorJSON;
}

export function topBlocks(ydoc: Y.Doc): { id: string; el: Y.XmlElement; index: number }[] {
  const out: { id: string; el: Y.XmlElement; index: number }[] = [];
  ydoc
    .getXmlFragment(FRAGMENT)
    .toArray()
    .forEach((el, index) => {
      if (el instanceof Y.XmlElement) out.push({ id: String(el.getAttribute("id") ?? ""), el, index });
    });
  return out;
}

/** sha256 of the block's normalized text, as `blocks.content_hash`. An atom hashes its source's hash. */
export function contentHash(node: ProseMirrorJSON): string {
  const text = node.type === "atom" ? `atom:${String(node.attrs?.hash ?? "")}` : normalizedText(node);
  return createHash("sha256").update(text).digest("hex");
}

/** What `base` an agent passes back: the first 12 characters of the content hash. */
export const blockBase = (node: ProseMirrorJSON) => contentHash(node).slice(0, 12);

/**
 * Give every top-level block a valid, unique id in one server-origin transaction (13, "The server's
 * check on every update"). The first holder keeps an id. Returns the ids it changed, by index.
 */
export function fixIds(ydoc: Y.Doc, mint: () => string = mintBlockId): number[] {
  const blocks = topBlocks(ydoc);
  const repairs = idRepairs(
    blocks.map(({ el }) => ({
      id: el.getAttribute("id"),
      empty:
        el.length === 0 ||
        (el.length === 1 && el.get(0) instanceof Y.XmlText && (el.get(0) as Y.XmlText).length === 0),
    })),
  );
  if (repairs.length === 0) return [];
  const taken = new Set(blocks.map((block) => block.id));
  ydoc.transact(() => {
    for (const index of repairs) {
      let id = mint();
      while (taken.has(id)) id = mint();
      taken.add(id);
      blocks[index]?.el.setAttribute("id", id);
    }
  }, SERVER_ORIGIN);
  return repairs.map((index) => blocks[index]?.index ?? index);
}

const ATOMS = new Set<string>(ATOM_KINDS);

/** Attributes and marks only as the schema knows them: an unknown one is refused, not dropped. */
function checkShape(node: ProseMirrorJSON, path: string): string | null {
  const type = editorSchema.nodes[node.type];
  if (!type) return `${path}: unknown node ${node.type}`;
  for (const key of Object.keys(node.attrs ?? {})) {
    if (key === "ychange") continue;
    if (!(key in (type.spec.attrs ?? {}))) return `${path}: unknown attribute ${key} on ${node.type}`;
  }
  for (const mark of node.marks ?? []) {
    const markType = editorSchema.marks[mark.type];
    if (!markType) return `${path}: unknown mark ${mark.type}`;
    for (const key of Object.keys(mark.attrs ?? {}))
      if (!(key in (markType.spec.attrs ?? {}))) return `${path}: unknown attribute ${key} on ${mark.type}`;
    if (mark.type === "link" && !safeHref(mark.attrs?.href))
      return `${path}: a link to a scheme that isn't allowed`;
  }
  if (node.type === "table_cell" || node.type === "table_header") {
    if (Number(node.attrs?.colspan ?? 1) !== 1 || Number(node.attrs?.rowspan ?? 1) !== 1)
      return `${path}: merged table cells have no Markdown form`;
  }
  for (const [index, child] of (node.content ?? []).entries()) {
    const problem = checkShape(child, `${path}/${index}`);
    if (problem) return problem;
  }
  return null;
}

/**
 * Whether a draft is one the server can keep (13, "Writing an update"): every top-level block (or the
 * `touched` ones) is valid in the schema, with no unknown attribute or mark, atoms are of a known kind
 * and, given `atoms`, hold a source this artifact has. Ids are fixed with `fixIds`, not refused here;
 * authors are checked against the update by the socket.
 */
export function validate(
  ydoc: Y.Doc,
  touched?: Set<string>,
  opts: { atoms?: (hash: string) => boolean } = {},
): { ok: true } | { ok: false; reason: string } {
  const fragment = ydoc.getXmlFragment(FRAGMENT);
  if (fragment.length > EDIT_BLOCKS_MAX) return { ok: false, reason: "too many blocks" };
  if (fragment.length === 0) return { ok: false, reason: "an empty document" };
  for (const [index, el] of fragment.toArray().entries()) {
    if (!(el instanceof Y.XmlElement)) return { ok: false, reason: `block ${index} isn't an element` };
    if (!TOP_BLOCKS.has(el.nodeName))
      return { ok: false, reason: `block ${index}: ${el.nodeName} can't be top-level` };
    const id = String(el.getAttribute("id") ?? "");
    if (touched && !touched.has(id)) continue;
    const json = elementToJSON(el);
    const shape = checkShape(json, `block ${index}`);
    if (shape) return { ok: false, reason: shape };
    try {
      editorSchema.nodeFromJSON(json).check();
    } catch (error) {
      return { ok: false, reason: `block ${index}: ${(error as Error).message}` };
    }
    if (json.type === "atom") {
      const kind = String(json.attrs?.kind ?? "");
      const hash = String(json.attrs?.hash ?? "");
      if (!ATOMS.has(kind)) return { ok: false, reason: `block ${index}: unknown atom kind` };
      if (!SHA256_HEX.test(hash) || (opts.atoms && !opts.atoms(hash)))
        return { ok: false, reason: `block ${index}: an atom the server doesn't have` };
    }
  }
  return { ok: true };
}
