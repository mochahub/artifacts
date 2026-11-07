import { createHash } from "node:crypto";
import { elementToJSON } from "@artifacts/doc";
import {
  type AgentPolicy,
  type AtomKind,
  EDIT_BLOCKS_MAX,
  EDIT_CALL_MARKDOWN_MAX,
  EDIT_CALLS_PER_MINUTE,
  type EditOp,
  type EditRequest,
  type EditResult,
  MANIFEST,
  MINUTE_MS,
  type PageBlock,
  type PageRead,
  SUGGESTIONS_OPEN_MAX,
  type WikiMeta,
} from "@artifacts/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { LoadedArtifact } from "../auth/access.ts";
import { type Caller, limiterKey } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { activity, editAtoms, editDocs, pages, suggestions, threads, versions } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { blobKey } from "../layout.ts";
import { validateWikiSources } from "../wiki/service.ts";
import { checkpoint, queueFixes } from "./checkpoint.ts";
import {
  blockMarkdown,
  contentHash,
  docToY,
  markdownToDoc,
  mintBlockId,
  topBlocks,
  validate,
  yToDoc,
} from "./model.ts";
import { agentPolicy, type Policy, presenceAgain } from "./policy.ts";
import {
  type Actor,
  authorKey,
  type DocLock,
  editActor,
  editability,
  ensureDoc,
  loadDoc,
  persistUpdate,
  withDocLock,
} from "./store.ts";
import { authorsFor, createSuggestions, toSuggestions, visibleSources } from "./suggestions.ts";

/**
 * Agents' operations on a page's draft (13, "Policy" and "Hosted MCP tools"): replace, insert, delete and
 * meta, each applied, filed as a suggestion or refused, and said which. A replace that applies is a text
 * diff inside the block, so someone typing in it on another replica keeps their characters.
 */

type Json = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Json[];
  marks?: Mark[];
  text?: string;
};
type Mark = { type: string; attrs?: Record<string, unknown> };
type Outcome = EditResult["results"][number];
type Reason = NonNullable<Outcome["reason"]>;
type TokenCaller = Extract<Caller, { kind: "cliToken" | "orgToken" }>;

/** Accepting a suggestion: a person decided, so no policy, held or limit applies; stale still does. */
export type AcceptActor = {
  personId: string;
  authorKey: string;
  actor: Actor;
  force?: boolean;
  /** An accepted insert's block takes the id its suggestion promised, so a run's later ops still find it. */
  newBlockId?: string | null;
};

const AUTHOR = "author";
const tooManyBlocks = `A page holds at most ${EDIT_BLOCKS_MAX} blocks. Split it into more pages.`;
/** About 20 KB of Markdown per `artifacts_page_read` answer. */
const READ_PAGE_BYTES = 20_000;
const base12 = (node: Json) => contentHash(node as never).slice(0, 12);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const BLOCK_TYPES: Record<string, PageBlock["type"]> = {
  paragraph: "paragraph",
  heading: "heading",
  bullet_list: "list",
  ordered_list: "list",
  table: "table",
  code_block: "code",
  blockquote: "quote",
  component: "component",
  horizontal_rule: "rule",
  atom: "atom",
};
const typeOf = (node: Json): PageBlock["type"] =>
  node.type === "blockquote" && node.attrs?.callout ? "callout" : (BLOCK_TYPES[node.type] ?? "paragraph");

// ---------------------------------------------------------------------------------------------------
// The Y side: comparing and patching a block in place.

type Attrs = Record<string, unknown>;
const stable = (value: unknown): string =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value ?? null)
    : Array.isArray(value)
      ? `[${value.map(stable).join(",")}]`
      : `{${Object.keys(value as Attrs)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stable((value as Attrs)[key])}`)
          .join(",")}}`;
/** Formatting without the attribution mark: what a person sees. */
const looks = (attrs: Attrs | undefined) => {
  const { [AUTHOR]: _, ...rest } = attrs ?? {};
  return rest;
};
const nodeAttrs = (el: Y.XmlElement) => {
  const { id: _, ...rest } = el.getAttributes() as Attrs;
  return Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== null && value !== undefined),
  );
};
const sameShape = (a: Y.XmlElement, b: Y.XmlElement) =>
  a.nodeName === b.nodeName && stable(nodeAttrs(a)) === stable(nodeAttrs(b));

type Child = Y.XmlElement | Y.XmlText;
const childrenOf = (el: Y.XmlElement) => el.toArray() as Child[];

/** What a node looks like, ignoring ids and who wrote it: equal signatures need no change. */
function signature(node: Child): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as { insert: unknown; attributes?: Attrs }[])
      .map((op) => `${stable(op.insert)}${stable(looks(op.attributes))}`)
      .join("");
  }
  return `<${node.nodeName}${stable(nodeAttrs(node))}>${childrenOf(node).map(signature).join("")}</>`;
}

type Unit = { text: Y.XmlText; ch: string; attrs: Attrs } | { el: Y.XmlElement; sig: string };
/** A textblock's content as characters and inline nodes, the way y-prosemirror lays it out. */
function units(parent: Y.XmlElement): Unit[] {
  const out: Unit[] = [];
  for (const child of childrenOf(parent)) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as { insert: unknown; attributes?: Attrs }[]) {
        if (typeof op.insert !== "string") continue;
        for (const ch of op.insert) {
          // One unit per UTF-16 code unit, as Yjs counts, so a surrogate pair is two.
          for (let i = 0; i < ch.length; i++)
            out.push({ text: child, ch: ch[i] as string, attrs: op.attributes ?? {} });
        }
      }
    } else out.push({ el: child, sig: signature(child) });
  }
  return out;
}
const sameUnit = (a: Unit | undefined, b: Unit | undefined) =>
  !!a && !!b && ("ch" in a ? "ch" in b && a.ch === b.ch : "sig" in b && a.sig === b.sig);
const isHigh = (unit: Unit | undefined) =>
  !!unit && "ch" in unit && unit.ch.charCodeAt(0) >= 0xd800 && unit.ch.charCodeAt(0) <= 0xdbff;

const isInline = (el: Y.XmlElement) =>
  childrenOf(el).some((child) => child instanceof Y.XmlText) || el.nodeName === "hard_break";
const textblock = (a: Y.XmlElement, b: Y.XmlElement) =>
  childrenOf(a).some((c) => c instanceof Y.XmlText || c.nodeName === "hard_break") ||
  childrenOf(b).some((c) => c instanceof Y.XmlText || c.nodeName === "hard_break") ||
  (childrenOf(a).length === 0 && !childrenOf(b).some((c) => c instanceof Y.XmlElement && !isInline(c)));

/** Where a position in a textblock's units falls: inside (or at the end of) a text, or between children. */
function locate(parent: Y.XmlElement, pos: number): { index: number; text?: Y.XmlText; offset: number } {
  let at = 0;
  const children = childrenOf(parent);
  for (const [index, child] of children.entries()) {
    if (child instanceof Y.XmlText) {
      if (pos <= at + child.length) return { index, text: child, offset: pos - at };
      at += child.length;
    } else {
      if (pos === at) return { index, offset: 0 };
      at += 1;
    }
  }
  return { index: children.length, offset: 0 };
}

/**
 * Patches a textblock's inline content toward `next`'s: one changed range, found by common prefix and
 * suffix, plus formatting changes on the characters kept. Kept characters keep their author.
 */
function patchInline(parent: Y.XmlElement, next: Y.XmlElement) {
  const before = units(parent);
  const after = units(next);
  let p = 0;
  while (p < before.length && p < after.length && sameUnit(before[p], after[p])) p++;
  if (p > 0 && isHigh(before[p - 1]) && p < before.length) p--;
  let s = 0;
  while (
    s < before.length - p &&
    s < after.length - p &&
    sameUnit(before[before.length - 1 - s], after[after.length - 1 - s])
  )
    s++;
  if (s > 0 && isHigh(before[before.length - s - 1])) s--;

  // Formatting on kept characters first, while offsets are the old ones.
  const kept: [number, number][] = [];
  for (let i = 0; i < p; i++) kept.push([i, i]);
  for (let i = 0; i < s; i++) kept.push([before.length - s + i, after.length - s + i]);
  const offsets = new Map<Y.XmlText, number>();
  {
    let at = 0;
    for (const child of childrenOf(parent)) {
      if (child instanceof Y.XmlText) offsets.set(child, at);
      at += child instanceof Y.XmlText ? child.length : 1;
    }
  }
  for (const [i, j] of kept) {
    const old = before[i];
    const neu = after[j];
    if (!old || !neu || !("ch" in old) || !("ch" in neu)) continue;
    const a = looks(old.attrs);
    const b = looks(neu.attrs);
    if (stable(a) === stable(b)) continue;
    const change: Attrs = { ...b };
    for (const key of Object.keys(a)) if (!(key in b)) change[key] = null;
    old.text.format(i - (offsets.get(old.text) ?? 0), 1, change);
  }

  // Delete the old middle, last child first so indices hold.
  const from = p;
  const to = before.length - s;
  if (to > from) {
    let at = 0;
    const spans = childrenOf(parent).map((child, index) => {
      const length = child instanceof Y.XmlText ? child.length : 1;
      const span = { child, index, start: at, length };
      at += length;
      return span;
    });
    for (const span of spans.reverse()) {
      const start = Math.max(from, span.start);
      const end = Math.min(to, span.start + span.length);
      if (end <= start) continue;
      if (span.child instanceof Y.XmlText) span.child.delete(start - span.start, end - start);
      else parent.delete(span.index, 1);
    }
  }

  // Insert the new middle, with its own formatting and the new author.
  let pos = from;
  const middle = after.slice(p, after.length - s);
  for (let i = 0; i < middle.length; ) {
    const unit = middle[i] as Unit;
    const place = locate(parent, pos);
    if ("ch" in unit) {
      let run = "";
      const attrs = unit.attrs;
      while (i < middle.length) {
        const u = middle[i] as Unit;
        if (!("ch" in u) || stable(u.attrs) !== stable(attrs)) break;
        run += u.ch;
        i++;
      }
      if (place.text) place.text.insert(place.offset, run, attrs);
      else {
        const text = new Y.XmlText();
        parent.insert(place.index, [text]);
        text.insert(0, run, attrs);
      }
      pos += run.length;
    } else {
      let index = place.index;
      if (place.text) {
        if (place.offset >= place.text.length) index = place.index + 1;
        else if (place.offset > 0) {
          // Split the text: its tail moves after the new node, formatting and author intact.
          const tail = sliceDelta(place.text, place.offset);
          place.text.delete(place.offset, place.text.length - place.offset);
          const rest = new Y.XmlText();
          parent.insert(place.index + 1, [rest]);
          rest.applyDelta(tail);
          index = place.index + 1;
        }
      }
      parent.insert(index, [unit.el.clone()]);
      pos += 1;
      i++;
    }
  }
}

function sliceDelta(text: Y.XmlText, from: number) {
  const out: { insert: string; attributes?: Attrs }[] = [];
  let at = 0;
  for (const op of text.toDelta() as { insert: string; attributes?: Attrs }[]) {
    const end = at + op.insert.length;
    if (end > from) out.push({ insert: op.insert.slice(Math.max(0, from - at)), attributes: op.attributes });
    at = end;
  }
  return out;
}

/** Patches `el`'s content toward `next`'s, keeping every element that can stay. Same shape assumed. */
function patchChildren(el: Y.XmlElement, next: Y.XmlElement) {
  if (textblock(el, next)) return patchInline(el, next);
  const a = childrenOf(el);
  const b = childrenOf(next);
  let p = 0;
  while (p < a.length && p < b.length && signature(a[p] as Child) === signature(b[p] as Child)) p++;
  let s = 0;
  while (
    s < a.length - p &&
    s < b.length - p &&
    signature(a[a.length - 1 - s] as Child) === signature(b[b.length - 1 - s] as Child)
  )
    s++;
  const oldMiddle = a.slice(p, a.length - s);
  const newMiddle = b.slice(p, b.length - s);
  if (oldMiddle.length === newMiddle.length) {
    newMiddle.forEach((child, i) => {
      const old = oldMiddle[i] as Child;
      if (old instanceof Y.XmlElement && child instanceof Y.XmlElement && sameShape(old, child)) {
        patchChildren(old, child);
      } else {
        el.delete(p + i, 1);
        el.insert(p + i, [child.clone() as Child]);
      }
    });
    return;
  }
  if (oldMiddle.length) el.delete(p, oldMiddle.length);
  if (newMiddle.length)
    el.insert(
      p,
      newMiddle.map((child) => child.clone() as Child),
    );
}

// ---------------------------------------------------------------------------------------------------
// Parsing an op's Markdown.

/** Marks every text node as this author's, as the editor's own typing is. */
function markAll(node: Json, mark: Mark): Json {
  if (node.type === "text")
    return { ...node, marks: [...(node.marks ?? []).filter((m) => m.type !== AUTHOR), mark] };
  return node.content ? { ...node, content: node.content.map((child) => markAll(child, mark)) } : node;
}

/**
 * An op's Markdown as top-level blocks, ready to insert: Y elements with fresh ids and the author's mark.
 * Agents can't create atoms (images, diagrams, charts, embeds, raw HTML), as `artifacts_publish_article`
 * can't: those come back as `atom`.
 */
function parseBlocks(
  markdown: string,
  mark: Mark,
): { blocks: Y.XmlElement[] } | { refused: Reason; message: string } {
  if (!markdown.trim())
    return { refused: "invalid", message: "markdown is empty. To remove a block, delete it." };
  let atom: AtomKind | null = null;
  let parsed: { doc: unknown; ids: string[] };
  try {
    parsed = markdownToDoc(markdown, {
      mint: mintBlockId,
      atom(kind) {
        atom ??= kind;
        return "0".repeat(64);
      },
    });
  } catch {
    return { refused: "invalid", message: "That Markdown couldn't be read." };
  }
  if (atom)
    return {
      refused: "atom",
      message: `Ops take text only: this Markdown makes ${atom === "markdown" ? "something the editor can't hold" : `a ${atom}`}. Add images, diagrams, charts and embeds with the CLI.`,
    };
  const doc = markAll(parsed.doc as Json, mark);
  if (!doc.content?.length) return { refused: "invalid", message: "That Markdown makes no blocks." };
  const fragment = docToY(doc as never).getXmlFragment("doc");
  // Kept in their own document, so they can be read; each is cloned where it goes in.
  return { blocks: fragment.toArray() as Y.XmlElement[] };
}

// ---------------------------------------------------------------------------------------------------
// applyOps

type Pending = {
  index: number;
  op: EditOp["op"];
  blockId: string | null;
  newBlockId: string | null;
  base: string | null;
  markdown: string | null;
  meta: Extract<EditOp, { op: "meta" }> extends infer M ? Omit<M, "op"> | null : never;
  reason: Reason | null;
  supersedes: string | null;
};

const refused = (index: number, reason: Reason, message: string, block: string | null = null): Outcome => ({
  index,
  outcome: "refused",
  block,
  suggestion: null,
  reason,
  message,
});

/** Why a suggestion and not an edit, in the result's words. A requested suggestion has no reason. */
const suggestionReason = (policy: AgentPolicy, suggest?: boolean): Reason | null =>
  policy.reason === "pair"
    ? "pair"
    : policy.reason === "audience" || policy.reason === "run"
      ? "audience"
      : suggest
        ? null
        : "audience";

/**
 * Applies one `EditRequest` to the draft, under the page's lock: every op lands applied, suggested or
 * refused, by the policy, in one persisted update. `accept` is a person accepting a suggestion: the ops
 * apply as that suggestion's author, with no policy.
 */
export async function applyOps(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact,
  request: EditRequest,
  accept?: AcceptActor,
): Promise<EditResult> {
  const bytes = request.ops.reduce(
    (sum, op) => sum + ("markdown" in op ? Buffer.byteLength(op.markdown) : 0),
    0,
  );
  if (bytes > EDIT_CALL_MARKDOWN_MAX) {
    throw new ApiError("too_large", "Those ops hold too much Markdown. Send fewer at a time.", {
      limit: EDIT_CALL_MARKDOWN_MAX,
    });
  }
  const state = await editability(deps, artifact);
  if (!state.editable) {
    throw new ApiError("conflict", "This page can't be edited here.", {
      reason: "not_editable",
      editable: state.reason,
    });
  }
  let policy: Policy;
  let actor: Actor;
  if (accept) {
    policy = { edits: "direct", reason: "maintained", text: "A person accepted this.", held: () => false };
    actor = accept.actor;
  } else {
    if (!(caller.kind === "cliToken" || caller.kind === "orgToken" || caller.kind === "person")) {
      throw new ApiError("forbidden", "You can't edit this page.");
    }
    if (!can(caller, "artifact.edit", artifact)) throw new ApiError("forbidden", "You can't edit this page.");
    deps.limits.hit(`edit:${limiterKey(caller) ?? caller.kind}`, EDIT_CALLS_PER_MINUTE, MINUTE_MS);
    policy = await agentPolicy(deps, caller, artifact, { run: request.run, suggest: request.suggest });
    actor = editActor(caller, request.agent ?? null);
  }
  let agents: AgentPolicy = { edits: policy.edits, reason: policy.reason, text: policy.text };

  if (policy.edits === "refused") {
    const reason: Reason = policy.reason === "writing" ? "writing" : "invalid";
    const [row] = await deps.db
      .select({ seq: editDocs.seq })
      .from(editDocs)
      .where(eq(editDocs.artifactId, artifact.id));
    return {
      results: request.ops.map((_, index) => refused(index, reason, policy.text)),
      seq: row?.seq ?? 0,
      version: null,
      agents,
    };
  }
  let runId = policy.reason === "run" ? (request.run ?? null) : null;

  const outcome = await withDocLock(deps, artifact.id, async (lock) => {
    if (!accept) {
      policy = await presenceAgain(deps, artifact.id, policy);
      agents = { edits: policy.edits, reason: policy.reason, text: policy.text };
      if (policy.reason !== "run") runId = null;
      if (policy.edits === "refused") {
        const text = policy.text;
        return {
          results: request.ops.map((_, index) => refused(index, "writing", text)),
          seq: lock.row?.seq ?? 0,
          last: null,
          refused: true,
        };
      }
    }
    const { ydoc, row } = await loadDoc(deps, artifact.id, lock);
    const key = accept?.authorKey ?? (await authorKey(deps, artifact.id, actor, request.sources ?? [], lock));
    const mark: Mark = {
      type: AUTHOR,
      attrs: { a: key, t: Math.floor(deps.clock.now().getTime() / MINUTE_MS) },
    };
    const atoms = await atomSources(lock, artifact.id);
    const fragment = ydoc.getXmlFragment("doc");
    const before = Y.encodeStateVector(ydoc);

    const runOpen =
      runId && policy.edits === "suggestion"
        ? await lock.tx
            .select({
              id: suggestions.id,
              op: suggestions.op,
              blockId: suggestions.blockId,
              newBlockId: suggestions.newBlockId,
            })
            .from(suggestions)
            .where(and(eq(suggestions.runId, runId), eq(suggestions.status, "open")))
        : [];
    const results: Outcome[] = [];
    const pending: Pending[] = [];
    const touched = new Set<string>();
    let meta: NonNullable<Pending["meta"]> | null = null;
    const find = (id: string) => topBlocks(ydoc).find((block) => block.id === id);
    const jsonAt = (el: Y.XmlElement) => elementToJSON(el) as Json;
    const asSuggestion = (direct: boolean, blockId: string | null) =>
      !direct
        ? suggestionReason(policy, request.suggest)
        : blockId && policy.held(blockId) && !accept
          ? ("held" as const)
          : false;

    for (const [index, op] of request.ops.entries()) {
      const direct = policy.edits === "direct";
      const wouldSuggest = (blockId: string | null) =>
        op.op === "insert" ? (!direct ? asSuggestion(false, null) : false) : asSuggestion(direct, blockId);
      if (op.op === "meta") {
        const { op: _, ...fields } = op;
        if (fields.sources?.length) {
          // Checked as a publish checks them, so a bad slug never reaches the draft and fails every checkpoint.
          try {
            await validateWikiSources(
              deps,
              artifact.row.orgId,
              caller,
              artifact.project.id,
              artifact.row.slug,
              {
                role: "page",
                sources: fields.sources,
              } as WikiMeta,
            );
          } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            results.push(refused(index, "invalid", error.message));
            continue;
          }
        }
        if (direct) {
          meta = { ...(meta ?? {}), ...fields };
          results.push({
            index,
            outcome: "applied",
            block: null,
            suggestion: null,
            reason: null,
            message: null,
          });
        } else {
          pending.push({
            index,
            op: "meta",
            blockId: null,
            newBlockId: null,
            base: null,
            markdown: null,
            meta: fields,
            reason: wouldSuggest(null) || null,
            supersedes: null,
          });
        }
        continue;
      }
      if (op.op === "insert") {
        const anchor = op.after === null ? null : find(op.after);
        const planned =
          op.after !== null && !anchor ? runOpen.find((s) => s.newBlockId === op.after) : undefined;
        if (op.after !== null && !anchor && !(planned && !direct)) {
          results.push(refused(index, "missing", `No block ${op.after} on this page. Read it again.`));
          continue;
        }
        const parsed = parseBlocks(op.markdown, mark);
        if ("refused" in parsed) {
          results.push(refused(index, parsed.refused, parsed.message));
          continue;
        }
        if (!direct) {
          pending.push({
            index,
            op: "insert",
            blockId: op.after,
            newBlockId: mintBlockId(),
            base: null,
            markdown: op.markdown,
            meta: null,
            reason: wouldSuggest(null) || null,
            supersedes: null,
          });
          continue;
        }
        if (topBlocks(ydoc).length + parsed.blocks.length > EDIT_BLOCKS_MAX) {
          results.push(refused(index, "limit", tooManyBlocks));
          continue;
        }
        const at = anchor ? anchor.index + 1 : 0;
        const promised = accept?.newBlockId;
        if (promised && !find(promised)) parsed.blocks[0]?.setAttribute("id", promised);
        ydoc.transact(() =>
          fragment.insert(
            at,
            parsed.blocks.map((el) => el.clone() as Y.XmlElement),
          ),
        );
        const ids = parsed.blocks.map((el) => String(el.getAttribute("id")));
        for (const id of ids) touched.add(id);
        results.push({
          index,
          outcome: "applied",
          block: ids[0] ?? null,
          suggestion: null,
          reason: null,
          message: null,
        });
        continue;
      }

      // replace and delete name a block, with the base the agent read.
      const target = find(op.block);
      const planned = !target
        ? runOpen.find((s) => s.op === "insert" && s.newBlockId === op.block)
        : undefined;
      if (!target && !(planned && !direct && op.op === "replace")) {
        results.push(
          refused(index, "missing", `No block ${op.block} on this page. Read it again.`, op.block),
        );
        continue;
      }
      if (target) {
        const node = jsonAt(target.el);
        if (op.op === "replace" && node.type === "atom") {
          results.push(
            refused(
              index,
              "atom",
              "That block is an image, diagram, chart or embed: delete it or write around it, don't rewrite it.",
              op.block,
            ),
          );
          continue;
        }
        if (base12(node) !== op.base && !accept?.force) {
          results.push(refused(index, "stale", blockMarkdown(node as never, atoms), op.block));
          continue;
        }
      }
      const parsed = op.op === "replace" ? parseBlocks(op.markdown, mark) : null;
      if (parsed && "refused" in parsed) {
        results.push(refused(index, parsed.refused, parsed.message, op.block));
        continue;
      }
      const suggest = target ? wouldSuggest(op.block) : (suggestionReason(policy, request.suggest) ?? null);
      if (suggest !== false) {
        const earlier = runOpen.find(
          (s) => (s.op === "replace" || s.op === "delete") && s.blockId === op.block,
        );
        pending.push(
          planned
            ? {
                index,
                op: "insert",
                blockId: runInsertAfter(runOpen, planned.id),
                newBlockId: op.block,
                base: null,
                markdown: (op as { markdown: string }).markdown,
                meta: null,
                reason: suggest,
                supersedes: planned.id,
              }
            : {
                index,
                op: op.op,
                blockId: op.block,
                newBlockId: null,
                base: op.base,
                markdown: op.op === "replace" ? op.markdown : null,
                meta: null,
                reason: suggest,
                supersedes: earlier?.id ?? null,
              },
        );
        continue;
      }
      const block = target as NonNullable<typeof target>;
      if (op.op === "delete") {
        if (topBlocks(ydoc).length <= 1) {
          results.push(
            refused(index, "invalid", "A page keeps at least one block. Replace it instead.", op.block),
          );
          continue;
        }
        ydoc.transact(() => fragment.delete(block.index, 1));
        results.push({
          index,
          outcome: "applied",
          block: op.block,
          suggestion: null,
          reason: null,
          message: null,
        });
        continue;
      }
      // One block becomes as many as the Markdown makes: the page mustn't pass the limit.
      if (
        topBlocks(ydoc).length - 1 + (parsed as { blocks: Y.XmlElement[] }).blocks.length >
        EDIT_BLOCKS_MAX
      ) {
        results.push(refused(index, "limit", tooManyBlocks, op.block));
        continue;
      }
      const [first, ...rest] = (parsed as { blocks: Y.XmlElement[] }).blocks as [
        Y.XmlElement,
        ...Y.XmlElement[],
      ];
      ydoc.transact(() => {
        if (sameShape(block.el, first)) patchChildren(block.el, first);
        else {
          // A new type: the element is replaced, and the first new block keeps the id.
          first.setAttribute("id", op.block);
          fragment.delete(block.index, 1);
          fragment.insert(block.index, [first.clone() as Y.XmlElement]);
        }
        if (rest.length)
          fragment.insert(
            block.index + 1,
            rest.map((el) => el.clone() as Y.XmlElement),
          );
      });
      touched.add(op.block);
      for (const el of rest) touched.add(String(el.getAttribute("id")));
      results.push({
        index,
        outcome: "applied",
        block: op.block,
        suggestion: null,
        reason: null,
        message: null,
      });
    }

    // One update for every applied op, checked whole before it's kept.
    const update = Y.encodeStateAsUpdate(ydoc, before);
    const changed = results.some((r) => r.outcome === "applied" && r.block !== null) || touched.size > 0;
    let seq = row.seq;
    if (changed) {
      const checked = validate(ydoc, touched);
      if (!checked.ok) {
        for (const [i, r] of results.entries()) {
          if (r.outcome === "applied" && r.block !== null)
            results[i] = refused(r.index, "invalid", `The page would be invalid: ${checked.reason}`, r.block);
        }
      } else seq = await persistUpdate(deps, artifact.id, update, actor, lock);
    }
    // Threads a direct edit addresses are marked fixed by the checkpoint that carries it (13, "Checkpoints").
    if (!accept && request.fixes?.length && results.some((r) => r.outcome === "applied")) {
      await queueFixes(lock, request.fixes, {
        personId: actor.personId,
        agent: actor.agent,
        tokenId: actor.tokenId,
      });
    }
    if (meta) {
      const merged = { ...(lock.row?.meta ?? {}), ...meta };
      await lock.tx
        .update(editDocs)
        .set({
          meta: merged,
          dirtySince: sql`coalesce(${editDocs.dirtySince}, ${deps.clock.now().toISOString()}::timestamptz)`,
          updatedAt: deps.clock.now(),
          lastActorPersonId: actor.personId,
          lastAgent: actor.agent,
        })
        .where(eq(editDocs.artifactId, artifact.id));
    }

    // Suggestions, one per op, through the one writer; past the page's limit, refused.
    const now = deps.clock.now();
    if (pending.length) {
      const made = await createSuggestions(deps, lock, artifact, {
        pageKey: row.pageKey,
        items: pending.map(({ reason: _, ...item }) => item),
        authorKey: key,
        actor,
        note: request.note ?? null,
        sources: request.sources ?? [],
        fixes: request.fixes ?? [],
        runId,
      });
      for (const item of pending) {
        const id = made.find((entry) => entry.index === item.index)?.id ?? null;
        if (!id) {
          results.push(
            refused(
              item.index,
              "limit",
              `This page has ${SUGGESTIONS_OPEN_MAX} open suggestions. Wait for people to decide some.`,
              item.blockId,
            ),
          );
          continue;
        }
        results.push({
          index: item.index,
          outcome: "suggested",
          block: item.op === "insert" ? item.newBlockId : item.blockId,
          suggestion: id,
          reason: item.reason,
          message: null,
        });
        lock.after(() => deps.docs?.notify(artifact.id, "c", { t: "suggestion", id, status: "open" }));
      }
    }
    results.sort((a, b) => a.index - b.index);

    if (!accept) {
      const applied = results.filter((r) => r.outcome === "applied");
      const suggested = results.filter((r) => r.outcome === "suggested").length;
      const log = (kind: "edited" | "suggested", payload: Record<string, unknown>) =>
        lock.tx.insert(activity).values({
          id: Bun.randomUUIDv7(),
          orgId: artifact.row.orgId,
          artifactId: artifact.id,
          projectId: artifact.project.id,
          actorPersonId: actor.personId,
          agent: actor.agent,
          kind,
          payload,
          createdAt: now,
        });
      if (applied.length) {
        await log("edited", {
          ops: applied.length,
          blocks: applied.flatMap((r) => (r.block ? [r.block] : [])),
          ...(runId ? { run: runId } : {}),
        });
      }
      if (suggested) await log("suggested", { count: suggested, ...(runId ? { run: runId } : {}) });
    }
    const last = [...results].reverse().find((r) => r.block)?.block ?? null;
    return { results, seq, last, refused: false };
  });

  if (!accept && !outcome.refused && deps.docs && "agentPresence" in deps.docs) {
    (
      deps.docs as {
        agentPresence(artifactId: string, author: unknown, block: string | null, run: string | null): void;
      }
    ).agentPresence(
      artifact.id,
      { kind: "agent", name: actor.agent, personId: actor.personId },
      outcome.last,
      runId,
    );
  }

  let version: number | null = null;
  const everyApplied = outcome.results.every((r) => r.outcome === "applied");
  if (
    request.checkpoint &&
    everyApplied &&
    !accept &&
    (caller.kind === "cliToken" || caller.kind === "orgToken" || caller.kind === "person")
  ) {
    // The ops are already kept: a checkpoint that fails says so with no version, never as a failed edit.
    try {
      const made = await checkpoint(deps, artifact.id, {
        kind: caller.kind === "person" ? "saved" : "agent",
        personId: actor.personId ?? (caller.kind === "orgToken" ? caller.createdBy : null),
        agent: actor.agent,
        message: request.note ?? null,
      });
      version = made.version;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  }
  return { results: outcome.results, seq: outcome.seq, version, agents };
}

/** The block a superseded run insert went after, so its replacement goes there too. */
function runInsertAfter(open: { id: string; blockId: string | null }[], id: string) {
  return open.find((s) => s.id === id)?.blockId ?? null;
}

/**
 * The draft for reading, without the page's lock, so a read never holds up typing or a publish: one
 * read-only snapshot of the row, its updates and its atoms, so a compaction between them can't drop any.
 * Only a page with no draft yet is seeded, under the lock as seeding always is.
 */
async function readDraft(deps: Deps, artifact: LoadedArtifact) {
  for (let attempt = 0; ; attempt++) {
    await ensureDoc(deps, artifact);
    const read = await deps.db.transaction(
      async (tx) => {
        const [row] = await tx.select().from(editDocs).where(eq(editDocs.artifactId, artifact.id));
        // Retired between the two (a publish landed): seed again and read again.
        if (!row || row.snapshot.length === 0) return null;
        const view: DocLock = { tx, row, after: () => {} };
        const { ydoc, row: current } = await loadDoc(deps, artifact.id, view);
        return { doc: yToDoc(ydoc) as Json, row: current, atoms: await atomSources(view, artifact.id) };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    if (read || attempt > 0) {
      if (!read) throw new ApiError("conflict", "This page changed as it was read. Read it again.");
      return read;
    }
  }
}

async function atomSources(lock: DocLock, artifactId: string) {
  const rows = await lock.tx
    .select({ hash: editAtoms.hash, source: editAtoms.source })
    .from(editAtoms)
    .where(eq(editAtoms.artifactId, artifactId));
  const map = new Map(rows.map((r) => [r.hash, r.source]));
  return (hash: string) => map.get(hash) ?? "";
}

// ---------------------------------------------------------------------------------------------------
// artifacts_page_read

/** Author keys on a block's text, in order of first appearance. */
function authorsIn(node: Json, out = new Set<string>()) {
  for (const mark of node.marks ?? [])
    if (mark.type === AUTHOR && typeof mark.attrs?.a === "string") out.add(mark.attrs.a);
  for (const child of node.content ?? []) authorsIn(child, out);
  return out;
}

/**
 * A page as blocks to edit (13, "Hosted MCP tools"): the draft for a caller who can edit (the default),
 * else the latest version. Suggestions, presence and the draft's attribution only reach editors.
 */
export async function pageRead(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact,
  input: { draft?: boolean; cursor?: string },
): Promise<PageRead> {
  const canEdit = can(caller, "artifact.edit", artifact);
  if (input.draft && !canEdit)
    throw new ApiError("forbidden", "Reading the draft needs the edit right and scope.");
  const state = await editability(deps, artifact);
  const draft = (input.draft ?? canEdit) && state.editable;
  const policy = await agentPolicy(deps, caller, artifact);
  const agents: AgentPolicy = { edits: policy.edits, reason: policy.reason, text: policy.text };
  const start = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
  if (!Number.isInteger(start) || start < 0) throw new ApiError("invalid", "That cursor isn't valid.");

  let nodes: Json[];
  let atoms: (hash: string) => string;
  let seq = 0;
  let meta: { title?: string; summary?: string; tags?: string[]; sources?: string[] } | null = null;
  if (draft) {
    const loaded = await readDraft(deps, artifact);
    nodes = loaded.doc.content ?? [];
    atoms = loaded.atoms;
    seq = loaded.row.seq;
    meta = loaded.row.meta ?? null;
  } else {
    ({ nodes, atoms } = await versionBlocks(deps, artifact));
  }

  const blocks: PageBlock[] = [];
  let size = 0;
  let next: string | null = null;
  const used = new Set<string>();
  const ids = nodes.map((node) => String(node.attrs?.id ?? ""));
  const anchored = await threadsByBlock(deps, artifact.id, ids);
  for (let i = start; i < nodes.length; i++) {
    const node = nodes[i] as Json;
    const markdown = blockMarkdown(node as never, atoms);
    if (blocks.length > 0 && size + markdown.length > READ_PAGE_BYTES) {
      next = String(i);
      break;
    }
    size += markdown.length;
    const authors = draft ? [...authorsIn(node)] : [];
    for (const a of authors) used.add(a);
    blocks.push({
      id: ids[i] as string,
      type: typeOf(node),
      base: base12(node),
      markdown,
      atom: node.type === "atom" ? (node.attrs?.kind as AtomKind) : null,
      authors,
      threads: anchored.get(ids[i] as string) ?? [],
    });
  }

  const [latest] = await deps.db
    .select({ summary: versions.summary, tags: versions.tags, wiki: versions.wiki })
    .from(versions)
    .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, artifact.row.latestVersion)))
    .limit(1);
  return {
    artifact: `${artifact.project.slug}/${artifact.row.slug}`,
    title: meta?.title ?? artifact.row.title,
    summary: meta?.summary ?? latest?.summary ?? null,
    tags: meta?.tags ?? latest?.tags ?? [],
    sources: meta?.sources ?? latest?.wiki?.sources ?? [],
    version: artifact.row.latestVersion,
    draft,
    seq,
    agents,
    blocks,
    authors: draft
      ? await authorsFor(deps, artifact.id, [...used], await visibleSources(deps, caller, artifact))
      : [],
    suggestions: draft && canEdit ? await openSuggestions(deps, caller, artifact) : [],
    nextCursor: next,
  };
}

/** Open suggestions on the page, so an agent doesn't repeat one. Their text is untrusted. */
async function openSuggestions(deps: Deps, caller: Caller, artifact: LoadedArtifact) {
  const rows = await deps.db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.artifactId, artifact.id), eq(suggestions.status, "open")))
    .orderBy(asc(suggestions.createdAt))
    .limit(100);
  return toSuggestions(deps, caller, artifact, rows);
}

/** The latest version's blocks, parsed from its Markdown with the ids its checkpoint recorded. */
async function versionBlocks(deps: Deps, artifact: LoadedArtifact) {
  const found = await versionMarkdown(deps, artifact);
  const sources = new Map<string, string>();
  const atom = (_kind: AtomKind, source: string) => {
    const hash = sha256(source);
    sources.set(hash, source);
    return hash;
  };
  if (!found) return { nodes: [] as Json[], atoms: (hash: string) => sources.get(hash) ?? "" };
  const { doc } = markdownToDoc(found.markdown, { ids: found.blockIds, mint: mintBlockId, atom });
  return { nodes: ((doc as Json).content ?? []) as Json[], atoms: (hash: string) => sources.get(hash) ?? "" };
}

async function blobText(deps: Deps, hash: string | undefined) {
  if (!hash) return null;
  const object = await deps.bucket.get(blobKey(hash));
  return object ? new TextDecoder().decode(object.body) : null;
}

/** The latest version's article Markdown (the manifest page's `src`), and the ids a checkpoint gave it. */
async function versionMarkdown(deps: Deps, artifact: LoadedArtifact) {
  const [found] = await deps.db
    .select({ files: versions.files, key: pages.pageKey, kind: pages.kind, meta: pages.meta })
    .from(versions)
    .innerJoin(pages, eq(pages.versionId, versions.id))
    .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, artifact.row.latestVersion)))
    .orderBy(asc(pages.position))
    .limit(1);
  if (!found || found.kind !== "article") return null;
  const manifest = JSON.parse((await blobText(deps, found.files[MANIFEST]?.hash)) ?? "{}") as {
    pages?: { id: string; src?: string }[];
  };
  const src = manifest.pages?.find((entry) => entry.id === found.key)?.src;
  const markdown = src ? await blobText(deps, found.files[src]?.hash) : null;
  return markdown === null ? null : { markdown, blockIds: found.meta.blockIds };
}

/** Open threads by the block they anchor to. */
async function threadsByBlock(deps: Deps, artifactId: string, ids: string[]) {
  const map = new Map<string, number[]>();
  if (!ids.length) return map;
  const rows = await deps.db
    .select({ n: threads.n, anchor: threads.anchor })
    .from(threads)
    .where(and(eq(threads.artifactId, artifactId), eq(threads.status, "open")))
    .orderBy(asc(threads.n));
  const wanted = new Set(ids);
  for (const row of rows) {
    const key = (row.anchor as { blockKey?: string } | null)?.blockKey;
    if (!key || !wanted.has(key)) continue;
    map.set(key, [...(map.get(key) ?? []), row.n]);
  }
  return map;
}

export type { TokenCaller };
