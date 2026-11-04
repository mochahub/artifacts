/**
 * What changed in an article since the version before, marked in the page itself: added words in
 * `<ins class="chg">`, removed words in `<del class="chg">` where they used to be, a whole added block
 * with `.chg-new` and a whole removed one put back as `.chg-gone`. The marks stay in the page and the
 * stylesheet shows them only while Changes is on, so the removed words are never the author's text:
 * comments skip them (marks.ts).
 */

/** Removed words and blocks: not part of the current version, so not quoted or highlighted. */
export const GONE = "del.chg, .chg-gone";

export type Op = { op: "same" | "add" | "remove"; a: number; b: number };

const space = (token: string) => /^\s/.test(token);
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** Words, runs of punctuation, and the space between: `pipeline.` to `pipeline:` changes one mark. */
const TOKEN = /\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_'’-]+/gu;

export function tokens(text: string) {
  return text.match(TOKEN) ?? [];
}

/** Index pairs of a longest common subsequence, in order. Equal ends are matched first, cheaply. */
export function common(a: string[], b: string[]): [number, number][] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end])
    end++;
  const n = a.length - start - end;
  const m = b.length - start - end;
  const pairs: [number, number][] = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);
  if (n > 0 && m > 0 && n * m <= 4_000_000) {
    // lengths[i][j]: the longest common run of a[start+i..] and b[start+j..].
    const lengths = new Uint16Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lengths[at(i, j)] =
          a[start + i] === b[start + j]
            ? (lengths[at(i + 1, j + 1)] as number) + 1
            : Math.max(lengths[at(i + 1, j)] as number, lengths[at(i, j + 1)] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        pairs.push([start + i, start + j]);
        i++;
        j++;
      } else if ((lengths[at(i + 1, j)] as number) >= (lengths[at(i, j + 1)] as number)) i++;
      else j++;
    }
  }
  for (let k = end; k > 0; k--) pairs.push([a.length - k, b.length - k]);
  return pairs;
}

/** The edit from `a` to `b`: each token kept, added or removed, in reading order. */
export function diff(a: string[], b: string[]): Op[] {
  // Any two runs of space are the same: a line break in the source isn't a change.
  const pairs = common(
    a.map((t) => (space(t) ? " " : t)),
    b.map((t) => (space(t) ? " " : t)),
  );
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  for (const [pa, pb] of [...pairs, [a.length, b.length] as [number, number]]) {
    while (i < pa) ops.push({ op: "remove", a: i++, b: j });
    while (j < pb) ops.push({ op: "add", a: i, b: j++ });
    if (pa < a.length) ops.push({ op: "same", a: i++, b: j++ });
  }
  return ops;
}

/** How alike two texts are, by their words: 1 is the same words, 0 none in common. */
export function likeness(a: string, b: string) {
  const split = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const left = split(a);
  const right = split(b);
  if (left.length === 0 && right.length === 0) return 1;
  const kept = common(left, right).length;
  return (2 * kept) / (left.length + right.length);
}

export type Block = { key: string; tag: string; text: string; lead?: string };

/** Lists and tables are edited a part at a time, so even a list that is half new is still the list. */
const LOOSE = new Set(["UL", "OL", "TABLE"]);

/** Whether `now` is `then` edited: the same kind, and still reading mostly the same. A table row keeps its label. */
function edited(then: Block, now: Block) {
  if (then.tag !== now.tag) return false;
  if (then.tag === "TR" && then.lead && then.lead === now.lead) return true;
  return likeness(then.text, now.text) >= (LOOSE.has(then.tag) ? 0.2 : 0.5);
}

export type Step =
  | { kind: "same"; a: number; b: number }
  | { kind: "edit"; a: number; b: number }
  | { kind: "add"; b: number }
  | { kind: "remove"; a: number };

/**
 * Lines up two lists of blocks. Identical blocks anchor the match; between anchors a block that still
 * reads mostly the same (and is the same kind) is an edit, and the rest were added or removed.
 * Where blocks were swapped for others, the removed ones come first, as old then new.
 */
export function align(a: Block[], b: Block[]): Step[] {
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  let run: Step[] = [];
  const flush = () => {
    steps.push(...run.filter((s) => s.kind === "remove"), ...run.filter((s) => s.kind === "add"));
    run = [];
  };
  const gap = (endA: number, endB: number) => {
    for (; j < endB; j++) {
      const block = b[j] as Block;
      let found = -1;
      for (let k = i; k < endA && k < i + 6; k++) {
        if (edited(a[k] as Block, block)) {
          found = k;
          break;
        }
      }
      if (found < 0) {
        run.push({ kind: "add", b: j });
        continue;
      }
      while (i < found) run.push({ kind: "remove", a: i++ });
      flush();
      steps.push({ kind: "edit", a: i++, b: j });
    }
    while (i < endA) run.push({ kind: "remove", a: i++ });
    flush();
  };
  for (const [pa, pb] of common(
    a.map((x) => x.key),
    b.map((x) => x.key),
  )) {
    gap(pa, pb);
    steps.push({ kind: "same", a: i++, b: j++ });
  }
  gap(a.length, b.length);
  return steps;
}

// The DOM half: reading blocks, and marking the page.

const describe = (el: Element) => {
  const text = flat(el.textContent ?? "");
  const images = [...el.querySelectorAll("img")].map((img) => img.getAttribute("src")).join(" ");
  const lead = el.tagName === "TR" ? flat(el.firstElementChild?.textContent ?? "") : undefined;
  return { tag: el.tagName, text, lead, key: `${el.tagName}|${text}|${images}` };
};

/** Text nodes in reading order, with the comment tabs and the earlier change marks left out. */
function texts(root: Element) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node as Text).parentElement?.closest(`.mm, ${GONE}`)) continue;
    nodes.push(node as Text);
  }
  return nodes;
}

/** Marks the words of `now` that `then` didn't have, and puts back the words it lost. */
function words(then: Element, now: Element) {
  const before = texts(then).flatMap((node) => tokens(node.data));
  const after = texts(now).flatMap((node) =>
    [...node.data.matchAll(TOKEN)].map((m) => ({
      node,
      from: m.index,
      to: m.index + m[0].length,
      word: !space(m[0]),
    })),
  );
  const ops = diff(
    before,
    after.map((t) => t.node.data.slice(t.from, t.to)),
  );
  // Every edit, by the token it lands on. Applied from the end back, so splitting a text node never
  // moves an offset still to come.
  const edits: { at: number; ins?: { to: number }; del?: string }[] = [];
  let lost: string[] = [];
  let lostAt = 0;
  const flush = () => {
    const text = lost.join("").trim();
    if (text) edits.push({ at: lostAt, del: text });
    lost = [];
  };
  for (const op of ops) {
    if (op.op === "remove") {
      if (lost.length === 0) lostAt = op.b;
      lost.push(before[op.a] as string);
      continue;
    }
    flush();
    const token = after[op.b];
    if (op.op !== "add" || !token?.word) continue;
    const last = edits.at(-1)?.ins;
    const gap = after[op.b - 1];
    // Added words in a row are one mark, the space between them too, when they share a text node.
    const joins =
      last &&
      gap?.node === token.node &&
      (last.to === op.b - 1 || (last.to === op.b - 2 && !gap.word && after[op.b - 2]?.node === token.node));
    if (last && joins) last.to = op.b;
    else edits.push({ at: op.b, ins: { to: op.b } });
  }
  flush();

  edits.sort((x, y) => y.at - x.at || (x.ins ? -1 : 1));
  for (const edit of edits) {
    if (edit.ins) {
      const first = after[edit.at] as (typeof after)[number];
      const range = document.createRange();
      range.setStart(first.node, first.from);
      range.setEnd(first.node, (after[edit.ins.to] as (typeof after)[number]).to);
      const ins = document.createElement("ins");
      ins.className = "chg";
      range.surroundContents(ins);
      continue;
    }
    // Removed words go where they were: before the token now in their place, or after the last one.
    const del = document.createElement("del");
    del.className = "chg";
    del.textContent = edit.del as string;
    const next = after[edit.at];
    const prev = after[edit.at - 1];
    if (prev?.word) del.classList.add("gap-l");
    if (next?.word) del.classList.add("gap-r");
    if (next) {
      const range = document.createRange();
      range.setStart(next.node, next.from);
      range.insertNode(del);
    } else if (prev) prev.node.after(del);
    else now.append(del);
  }
  return edits.length > 0 ? 1 : 0;
}

/** A removed block, put back where it was. Never commentable: it has no block id. */
function ghost(old: Element) {
  const copy = old.cloneNode(true) as Element;
  for (const el of [copy, ...copy.querySelectorAll("[data-block], [id]")]) {
    el.removeAttribute("data-block");
    el.removeAttribute("id");
  }
  // Hidden until Changes is on, so not fetched until then.
  for (const img of copy.querySelectorAll("img")) img.loading = "lazy";
  copy.classList.add("chg-gone");
  copy.setAttribute("aria-label", "Removed");
  return copy;
}

const rows = (table: Element) => [...table.querySelectorAll(":scope > * > tr, :scope > tr")];

/**
 * Lines up two sibling lists and marks the changes: whole items added or removed, and the words of
 * the edited ones (by `edit`). Returns how many places changed, a run of changed items being one.
 */
function siblings(
  then: Element[],
  now: Element[],
  parent: Element,
  edit: (then: Element, now: Element) => number,
) {
  let count = 0;
  let run = false;
  let placed: Element | null = null; // the last removed item put back at the end
  const steps = align(then.map(describe), now.map(describe));
  steps.forEach((step, index) => {
    let changed = 1;
    if (step.kind === "same") {
      run = false;
      return;
    }
    if (step.kind === "add") (now[step.b] as Element).classList.add("chg-new");
    else if (step.kind === "edit") changed = edit(then[step.a] as Element, now[step.b] as Element);
    else {
      const copy = ghost(then[step.a] as Element);
      // Before whatever comes next in the new version, or after the last thing in it.
      const next = steps.slice(index + 1).find((s) => s.kind !== "remove") as { b: number } | undefined;
      const after = placed ?? now.at(-1);
      if (next) (now[next.b] as Element).before(copy);
      else if (after) after.after(copy);
      else parent.append(copy);
      if (!next) placed = copy;
    }
    if (changed && !run) count++;
    run = run || changed > 0;
  });
  return count;
}

/** Changes inside one block. A list goes item by item and a table row by row, so cells keep their words. */
function block(then: Element, now: Element): number {
  if (/^(UL|OL)$/.test(now.tagName)) {
    return siblings([...then.children], [...now.children], now, block) ? 1 : 0;
  }
  const table = now.tagName === "TABLE" ? now : now.querySelector(":scope > table");
  const oldTable = then.tagName === "TABLE" ? then : then.querySelector(":scope > table");
  if (table && oldTable) {
    const body = table.querySelector("tbody") ?? table;
    return siblings(rows(oldTable), rows(table), body, (a, b) => {
      if (a.children.length !== b.children.length) return replace(a, b);
      let n = 0;
      for (let k = 0; k < b.children.length; k++)
        n += words(a.children[k] as Element, b.children[k] as Element);
      return n ? 1 : 0;
    })
      ? 1
      : 0;
  }
  // A new picture shows as one, old above new. So does a block rewritten more than kept: struck through
  // above the new one, it reads better than confetti.
  const pictures = (el: Element) =>
    [...el.querySelectorAll("img")].map((img) => img.getAttribute("src")).join(" ");
  if (pictures(then) !== pictures(now)) return replace(then, now);
  if (likeness(then.textContent ?? "", now.textContent ?? "") < 0.4) return replace(then, now);
  return words(then, now);
}

function replace(then: Element, now: Element) {
  now.before(ghost(then));
  now.classList.add("chg-new");
  return 1;
}

/**
 * Marks in `root` (the rendered article) what changed since `previous` (the version before, as HTML).
 * Returns how many places changed.
 */
export function markChanges(root: HTMLElement, previous: string) {
  const template = document.createElement("template");
  template.innerHTML = previous;
  return siblings([...template.content.children], [...root.children], root, block);
}

/** The first mark, to bring into view when Changes is turned on. */
export function firstChange(root: HTMLElement) {
  return root.querySelector<HTMLElement>("ins.chg, del.chg, .chg-gone, .chg-new");
}
