import type { ProjectArtifacts } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { ArrowDownUp, ChevronLeft, Search } from "lucide-preact";
import { useRoute } from "preact-iso";
import { ArtifactTile } from "../components/cards.tsx";
import { PlaceholderTiles } from "../components/placeholder.tsx";
import { Shell } from "../components/shell.tsx";
import { usePoll } from "../poll.ts";
import { useTitle } from "../title.ts";
import { SignedIn } from "./guard.tsx";
import { NotFound } from "./not-found.tsx";

const FILTERS = [
  ["all", "All"],
  ["your_turn", "Your turn"],
  ["approved", "Approved"],
  ["archived", "Archived"],
] as const;

function Project() {
  const { params } = useRoute();
  const q = useSignal("");
  const status = useSignal("all");
  const sort = useSignal("recent");
  const query = new URLSearchParams({ q: q.value, status: status.value, sort: sort.value });
  const { data, error, loading } = usePoll<ProjectArtifacts>(
    `/api/projects/${encodeURIComponent(params.project ?? "")}/artifacts?${query}`,
    60_000,
  );
  const project = data.value?.project;
  useTitle(project?.name);
  if (error.value?.status === 404) return <NotFound />;
  // The last list stays while the next filter loads; only a settled, empty answer says so.
  const artifacts = data.value?.artifacts;
  return (
    <Shell wide>
      <a class="back" href="/projects">
        <ChevronLeft />
        Projects
      </a>
      <div>
        <h1 class="h1">{project?.name ?? <span class="ph-line" style="width:50%;height:30px" />}</h1>
        {project?.repo && <div class="ss">{project.repo}</div>}
      </div>
      <div class="row">
        <label class="search grow">
          <Search />
          <input
            placeholder={`Find in ${project?.name ?? "this project"}`}
            aria-label="Find in this project"
            value={q.value}
            onInput={(e) => {
              q.value = e.currentTarget.value;
            }}
          />
        </label>
        <label class="sort">
          <select
            aria-label="Sort"
            value={sort.value}
            onChange={(e) => {
              sort.value = e.currentTarget.value;
            }}
          >
            <option value="recent">Recent</option>
            <option value="name">Name</option>
          </select>
          <ArrowDownUp />
        </label>
      </div>
      <div class="row">
        <div class="seg">
          {FILTERS.map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={status.value === value}
              onClick={() => {
                status.value = value;
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {artifacts ? (
        <div class="grid" aria-busy={loading.value}>
          {artifacts.map((card) => (
            <ArtifactTile card={card} key={card.id} />
          ))}
        </div>
      ) : (
        <PlaceholderTiles />
      )}
      {artifacts?.length === 0 && !loading.value && <div class="empty">Nothing here.</div>}
    </Shell>
  );
}

export const ProjectPage = () => (
  <SignedIn>
    <Project />
  </SignedIn>
);
