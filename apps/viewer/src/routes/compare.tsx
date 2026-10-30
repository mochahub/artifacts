import type { Artifact } from "@artifacts/schema";
import { ChevronLeft } from "lucide-preact";
import { useLocation, useRoute } from "preact-iso";
import { usePoll } from "../poll.ts";
import { artifactPath } from "./artifact.tsx";
import { useSignInOn401 } from "./guard.tsx";
import { NotFound } from "./not-found.tsx";

type Change = { added: string[]; removed: string[]; changed: string[] };
type Compare = { frames: Change; blocks: Change };

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

/** What changed between two versions, by content hash. Pixel regions arrive in M11. */
export function ComparePage() {
  const { params } = useRoute();
  const { query } = useLocation();
  const remote = usePoll<Artifact>(artifactPath(params.project ?? "", params.artifact ?? ""), 60_000);
  useSignInOn401(remote.error.value?.status);
  const artifact = remote.data.value;
  const compare = usePoll<Compare>(
    artifact
      ? `/api/artifacts/${artifact.id}/compare?from=${Number(query.from)}&to=${Number(query.to)}`
      : null,
    3_600_000,
  );
  if (compare.error.value || (remote.error.value && remote.error.value.status !== 401)) return <NotFound />;
  if (!artifact) return null;
  const nothing =
    compare.data.value &&
    [compare.data.value.frames, compare.data.value.blocks].every(
      (c) => c.added.length + c.removed.length + c.changed.length === 0,
    );
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
      {compare.data.value && <Rows title="Frames" change={compare.data.value.frames} />}
      {compare.data.value && <Rows title="Sections" change={compare.data.value.blocks} />}
    </main>
  );
}
