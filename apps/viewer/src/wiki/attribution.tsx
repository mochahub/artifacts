import type { Attribution, Author } from "@artifacts/schema";
import { FileText, Pencil, ShieldAlert } from "lucide-preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { Avatar } from "../components/cards.tsx";
import { Sheet } from "../components/sheet.tsx";
import { agentShort, ago } from "../format.ts";
import { artifactHref } from "../paths.ts";

/** A source a passage was written from, as the page's links know it. */
export type SourceInfo = { slug: string; project: string; title: string | null; untrusted: boolean };

/** One passage someone picked: who wrote it, and where on screen. */
export type Picked = { author: Author; time: string; rect: DOMRect };

// The margin tabs, the change marks and removed words aren't the author's words (marks.ts skips them too).
const SKIP = ".mm, del.chg, .chg-gone";

/**
 * The blue pencil in the reader (13, "Attribution"): every passage an agent wrote gets the pencil line,
 * mapped from `blocks.authors` offsets (the block's text, whitespace collapsed) onto its DOM text. People's
 * passages show nothing until asked. Safe to run again.
 */
export function decorateAuthors(root: HTMLElement, attribution: Attribution) {
  for (const pen of root.querySelectorAll("span.pen")) pen.replaceWith(...pen.childNodes);
  root.normalize();
  const authors = new Map(attribution.authors.map((author) => [author.key, author]));
  for (const [key, runs] of Object.entries(attribution.blocks)) {
    const block = root.querySelector<HTMLElement>(`[data-block="${CSS.escape(key)}"]`);
    if (!block) continue;
    const agents = runs.filter((run) => authors.get(run.a)?.kind === "agent");
    if (agents.length === 0) continue;
    const points = collapsedPoints(block);
    // From the end, so wrapping one passage doesn't move the offsets of the ones before it.
    for (const run of [...agents].sort((a, b) => b.s - a.s)) {
      const start = points[run.s];
      const end = points[Math.min(run.e, points.length) - 1];
      if (!start || !end || run.e <= run.s) continue;
      wrapRange(start, { node: end.node, offset: end.offset + 1 }, run.a, run.t);
    }
  }
}

type Point = { node: Text; offset: number };

/** For each character of the collapsed text, the DOM text position it came from. */
function collapsedPoints(block: HTMLElement): Point[] {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const points: Point[] = [];
  let space = true; // a leading space is trimmed
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.parentElement?.closest(SKIP)) continue;
    for (let offset = 0; offset < node.data.length; offset++) {
      if (/\s/.test(node.data[offset] ?? "")) {
        if (space) continue;
        space = true;
      } else space = false;
      points.push({ node, offset });
    }
  }
  // A trailing space is trimmed too.
  if (
    points.length &&
    /\s/.test(points[points.length - 1]?.node.data[points[points.length - 1]?.offset ?? 0] ?? "")
  )
    points.pop();
  return points;
}

/** Wraps a range that may cross inline elements, one text node at a time, so no element is split. */
function wrapRange(start: Point, end: Point, key: string, time: string) {
  const walker = document.createTreeWalker(
    start.node.parentElement?.closest("[data-block]") ?? start.node,
    NodeFilter.SHOW_TEXT,
  );
  const nodes: Text[] = [];
  let on = false;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node === start.node) on = true;
    if (on && !node.parentElement?.closest(SKIP)) nodes.push(node);
    if (node === end.node) break;
  }
  for (const node of nodes) {
    const from = node === start.node ? start.offset : 0;
    const to = node === end.node ? end.offset : node.length;
    if (from >= to) continue;
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    const pen = document.createElement("span");
    pen.className = "pen";
    pen.dataset.author = key;
    pen.dataset.time = time;
    range.surroundContents(pen);
  }
}

/** The passage under a tap or click, if an agent wrote it. */
export function pickedAt(target: EventTarget | null, attribution: Attribution): Picked | null {
  const pen = (target as HTMLElement | null)?.closest?.<HTMLElement>("span.pen[data-author]");
  const author = pen && attribution.authors.find((entry) => entry.key === pen.dataset.author);
  if (!pen || !author) return null;
  for (const lit of document.querySelectorAll("span.pen.lit")) lit.classList.remove("lit");
  for (const part of pen.closest("[data-block]")?.querySelectorAll<HTMLElement>("span.pen") ?? []) {
    if (part.dataset.author === author.key && part.dataset.time === pen.dataset.time)
      part.classList.add("lit");
  }
  return { author, time: pen.dataset.time ?? "", rect: pen.getBoundingClientRect() };
}

/** "Claude Code wrote this" for an agent; a person's name otherwise. */
export const wroteThis = (author: Author) =>
  `${author.kind === "agent" ? agentShort(author.agent ?? author.name) : author.name} wrote this`;

function Body({
  picked,
  version,
  sources,
}: {
  picked: Picked;
  version: number | null;
  sources: (slug: string) => SourceInfo | null;
}) {
  const { author, time } = picked;
  return (
    <>
      <div class="rowx">
        {author.kind === "agent" ? (
          <span class="av agent">
            <Pencil />
          </span>
        ) : (
          <Avatar name={author.name} />
        )}
        <div class="grow">
          <div class={`tt${author.kind === "agent" ? " agent-word" : ""}`}>{wroteThis(author)}</div>
          <div class="ss">
            {[
              author.for ? `For ${author.for}` : null,
              time ? ago(time) : null,
              version ? `v${version}` : "Draft",
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
      </div>
      {author.sources.length > 0 && (
        <>
          <span class="gh">From</span>
          <div class="group">
            {author.sources.map((slug) => {
              const info = sources(slug);
              const Icon = info?.untrusted ? ShieldAlert : FileText;
              const label = info?.title ?? slug;
              return info ? (
                <a class="li" href={artifactHref({ project: info.project, slug })} key={slug}>
                  <Icon />
                  <div class="grow">
                    <div class="tt">{label}</div>
                    {info.untrusted && <div class="ss warn-word">Untrusted source</div>}
                  </div>
                </a>
              ) : (
                <div class="li" key={slug}>
                  <Icon />
                  <div class="grow">
                    <div class="tt">{label}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

/**
 * Who wrote a passage: who, for whom, when, which version, and the sources, untrusted ones named. A sheet
 * on a phone; a popover by the passage on a wider screen.
 */
export function AuthorPopover({
  picked,
  version,
  sources,
  onClose,
}: {
  picked: Picked;
  version: number | null;
  sources: (slug: string) => SourceInfo | null;
  onClose(): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const wide = matchMedia("(min-width: 760px)").matches;
  useLayoutEffect(() => {
    if (!wide) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onDown = (event: PointerEvent) => {
      if (
        !box.current?.contains(event.target as Node) &&
        !(event.target as HTMLElement).closest?.("span.pen")
      )
        onClose();
    };
    addEventListener("keydown", onKey);
    addEventListener("pointerdown", onDown);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("pointerdown", onDown);
    };
  }, [wide, onClose]);
  useLayoutEffect(
    () => () => {
      for (const lit of document.querySelectorAll("span.pen.lit")) lit.classList.remove("lit");
    },
    [],
  );
  if (!wide)
    return (
      <Sheet title="Who wrote this" onClose={onClose}>
        <Body picked={picked} version={version} sources={sources} />
      </Sheet>
    );
  const left = Math.min(picked.rect.left, innerWidth - 350);
  return (
    <div
      ref={box}
      class="author-pop"
      role="dialog"
      aria-label="Who wrote this"
      style={{ left: `${Math.max(12, left)}px`, top: `${picked.rect.bottom + 10}px` }}
    >
      <Body picked={picked} version={version} sources={sources} />
    </div>
  );
}
