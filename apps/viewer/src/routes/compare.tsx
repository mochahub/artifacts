import type { Artifact } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { ChevronLeft } from "lucide-preact";
import { useLocation, useRoute } from "preact-iso";
import { isMissing } from "../api.ts";
import { renderUrl } from "../format.ts";
import { usePoll } from "../poll.ts";
import { artifactPath } from "./artifact.tsx";
import { useSignInOn401 } from "./guard.tsx";
import { NotFound } from "./not-found.tsx";

type Region = { x: number; y: number; w: number; h: number };
type Change = { added: string[]; removed: string[]; changed: string[] };
type FrameChange = { before: string; after: string; regions: Region[] };
type Compare = {
  frames: Change & { regions: Record<string, FrameChange> };
  blocks: Change;
  notes: Record<string, string>;
};
type Mode = "side" | "swipe" | "changes";

const MODES: [Mode, string][] = [
  ["side", "Side by side"],
  ["swipe", "Swipe"],
  ["changes", "Changes"],
];

function FrameDiff({
  artifactId,
  name,
  frame,
  mode,
  note,
}: {
  artifactId: string;
  name: string;
  frame: FrameChange;
  mode: Mode;
  note?: string;
}) {
  const split = useSignal(50);
  const before = renderUrl(artifactId, frame.before);
  const after = renderUrl(artifactId, frame.after);
  return (
    <figure class="diff">
      <figcaption>
        {name}
        {note && <p class="note">{note}</p>}
      </figcaption>
      {mode === "side" && (
        <div class="pair">
          <img src={before} alt={`${name}, before`} />
          <img src={after} alt={`${name}, after`} />
        </div>
      )}
      {mode === "swipe" && (
        <div class="swipe">
          <img src={after} alt={`${name}, after`} />
          <img
            src={before}
            alt={`${name}, before`}
            class="over"
            style={{ clipPath: `inset(0 ${100 - split.value}% 0 0)` }}
          />
          <span class="line" style={{ left: `${split.value}%` }} />
          <input
            type="range"
            min="0"
            max="100"
            aria-label="Before and after"
            value={split.value}
            onInput={(event) => {
              split.value = Number(event.currentTarget.value);
            }}
          />
        </div>
      )}
      {mode === "changes" && (
        <div class="marked">
          <img src={after} alt={name} />
          {frame.regions.map((region, index) => (
            <span
              class="region"
              key={`${region.x}:${region.y}`}
              style={{
                left: `${region.x * 100}%`,
                top: `${region.y * 100}%`,
                width: `${region.w * 100}%`,
                height: `${region.h * 100}%`,
              }}
            >
              <b>{index + 1}</b>
            </span>
          ))}
        </div>
      )}
    </figure>
  );
}

function Rows({ title, change }: { title: string; change: Change }) {
  const rows = [
    ...change.changed.map((key) => [key, "Changed"]),
    ...change.added.map((key) => [key, "Added"]),
    ...change.removed.map((key) => [key, "Removed"]),
  ];
  if (rows.length === 0) return null;
  return (
    <>
      <span class="gh">{title}</span>
      <div class="group">
        {rows.map(([key, word]) => (
          <div class="li" key={key}>
            <div class="grow">
              <div class="tt">{key}</div>
            </div>
            <span class="word agent">{word}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** What changed between two versions: the lists by content hash, and the frames themselves (board 02). */
export function ComparePage() {
  const { params } = useRoute();
  const { query } = useLocation();
  const mode = useSignal<Mode>("side");
  const remote = usePoll<Artifact>(artifactPath(params.project ?? "", params.artifact ?? ""), 60_000);
  useSignInOn401(remote.error.value?.status);
  const artifact = remote.data.value;
  const compare = usePoll<Compare>(
    artifact
      ? `/api/artifacts/${artifact.id}/compare?from=${Number(query.from)}&to=${Number(query.to)}`
      : null,
    3_600_000,
  );
  if (isMissing(compare.error.value) || isMissing(remote.error.value)) return <NotFound />;
  if (!artifact) return null;
  const nothing =
    compare.data.value &&
    [compare.data.value.frames, compare.data.value.blocks].every(
      (c) => c.added.length + c.removed.length + c.changed.length === 0,
    );
  const notes = compare.data.value?.notes ?? {};
  const changed = Object.entries(compare.data.value?.frames.regions ?? {});
  return (
    <main class="main">
      <a class="back" href={`/${artifact.project}/${artifact.slug}`}>
        <ChevronLeft />
        {artifact.title}
      </a>
      <h1 class="h1 m">
        v{query.from} and v{query.to}
      </h1>
      {nothing && <div class="empty">No differences.</div>}
      {changed.length > 0 && (
        <div class="seg">
          {MODES.map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={mode.value === value}
              onClick={() => {
                mode.value = value;
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {changed.map(([name, frame]) => (
        <FrameDiff
          key={name}
          artifactId={artifact.id}
          name={name}
          frame={frame}
          mode={mode.value}
          note={notes[name] ?? notes[name.split("/").at(-1) as string]}
        />
      ))}
      {compare.data.value && <Rows title="Frames" change={compare.data.value.frames} />}
      {compare.data.value && <Rows title="Sections" change={compare.data.value.blocks} />}
    </main>
  );
}
