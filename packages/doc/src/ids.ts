import { BLOCK_ID_PATTERN } from "@artifacts/schema/constants";
import { Fragment, type Node, Slice } from "prosemirror-model";
import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { ySyncPluginKey } from "y-prosemirror";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A lasting block id: `~` and ten base-36 characters (`BLOCK_ID_PATTERN`). */
export function mintBlockId(): string {
  let id = "~";
  while (id.length < 11) {
    // Bytes of 252 and up are drawn again: 252 is the largest multiple of 36 under 256, so no
    // character is likelier than another.
    for (const byte of crypto.getRandomValues(new Uint8Array(16)))
      if (byte < 252 && id.length < 11) id += ALPHABET[byte % 36];
  }
  return id;
}

export const isBlockId = (value: unknown): value is string =>
  typeof value === "string" && BLOCK_ID_PATTERN.test(value);

/**
 * Which top-level blocks need a new id, by index: none, malformed, or an id an earlier block has. The
 * first holder keeps an id, except after a split at the start of a block, where the empty block before
 * the content gives it up (13, "Editing behaviour"): the content keeps its id.
 */
export function idRepairs(blocks: { id: unknown; empty: boolean }[]): number[] {
  const repairs: number[] = [];
  const holder = new Map<string, number>();
  for (const [index, block] of blocks.entries()) {
    if (!isBlockId(block.id)) {
      repairs.push(index);
      continue;
    }
    const first = holder.get(block.id);
    if (first === undefined) {
      holder.set(block.id, index);
      continue;
    }
    const earlier = blocks[first];
    if (earlier?.empty && !block.empty && first === index - 1 && !repairs.includes(first)) {
      repairs.push(first);
      holder.set(block.id, index);
    } else repairs.push(index);
  }
  return repairs.sort((a, b) => a - b);
}

const fromSync = (tr: Transaction) => {
  const meta = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return Boolean(meta?.isChangeOrigin);
};

const stripIds = (fragment: Fragment): Fragment => {
  const nodes: Node[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      nodes.push(node);
      return;
    }
    const attrs = "id" in node.attrs && node.attrs.id !== null ? { ...node.attrs, id: null } : node.attrs;
    nodes.push(node.type.create(attrs, stripIds(node.content), node.marks));
  });
  return Fragment.from(nodes);
};

export const blockIdPluginKey = new PluginKey("blockIds");

/**
 * The client's id rules (13, "Format and generation"): give an id to a top-level block that has none
 * or a duplicate, never renumber one, skip y-sync transactions so peers don't ping-pong, and strip ids
 * from pasted content so a copy is a new block.
 */
export function blockIdPlugin(mint: () => string = mintBlockId): Plugin {
  return new Plugin({
    key: blockIdPluginKey,
    props: {
      transformPasted: (slice) => new Slice(stripIds(slice.content), slice.openStart, slice.openEnd),
    },
    appendTransaction(transactions, _old, state) {
      if (!transactions.some((tr) => tr.docChanged && !fromSync(tr))) return null;
      const blocks: { id: unknown; empty: boolean; pos: number; node: Node }[] = [];
      state.doc.forEach((node, pos) => {
        blocks.push({ id: node.attrs.id, empty: node.isTextblock && node.content.size === 0, pos, node });
      });
      const repairs = idRepairs(blocks);
      if (repairs.length === 0) return null;
      const tr = state.tr;
      for (const index of repairs) {
        const block = blocks[index] as (typeof blocks)[number];
        tr.setNodeMarkup(block.pos, undefined, { ...block.node.attrs, id: mint() });
      }
      return tr.setMeta("addToHistory", false);
    },
  });
}
