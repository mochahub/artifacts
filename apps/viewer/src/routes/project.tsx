import type { ProjectArtifacts } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { ChevronLeft, ChevronsUpDown, Search, Share } from "lucide-preact";
import { useRoute } from "preact-iso";
import { ArtifactTile } from "../components/cards.tsx";
import { SignedIn } from "../components/guard.tsx";
import { Loaded, NotFound } from "../components/loaded.tsx";
import { PlaceholderTiles } from "../components/placeholder.tsx";
import { ProjectShareSheet } from "../components/share.tsx";
import { Shell } from "../components/shell.tsx";
import { usePoll } from "../poll.ts";
import { meta } from "../session.ts";
import { useTitle } from "../title.ts";

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
  const sharing = useSignal(false);
  const poll = usePoll<ProjectArtifacts>(
    `/api/projects/${encodeURIComponent(params.project ?? "")}/artifacts?${query}`,
    60_000,
  );
  const project = poll.data.value?.project;
  useTitle(project?.name);
  // A project answers 404 when nothing in it is visible; never 410 (03).
  if (poll.error.value?.status === 404) return <NotFound />;
  return (
    <Shell wide>
      <a class="back" href="/projects">
        <ChevronLeft />
        Projects
      </a>
      <div>
        <div class="row">
          <h1 class="h1 grow">{project?.name ?? <span class="ph-line" style="width:50%;height:30px" />}</h1>
          {project?.canShare && (
            <button
              type="button"
              class="icon-btn"
              aria-label="Share"
              onClick={() => {
                sharing.value = true;
              }}
            >
              <Share />
            </button>
          )}
        </div>
        {project && (
          <div class="ss">{project.restricted ? "Restricted" : `Everyone in ${meta.value?.orgName}`}</div>
        )}
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
          <ChevronsUpDown />
        </label>
      </div>
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
      {/* The last list stays while the next filter loads; only a settled, empty answer says so. */}
      <Loaded from={[poll]} value={poll.data.value?.artifacts} placeholder={<PlaceholderTiles />}>
        {(artifacts) => (
          <>
            <div class="grid" aria-busy={poll.loading}>
              {artifacts.map((card) => (
                <ArtifactTile card={card} key={card.id} />
              ))}
            </div>
            {artifacts.length === 0 && !poll.loading && <div class="empty">Nothing here.</div>}
          </>
        )}
      </Loaded>
      {sharing.value && params.project && (
        <ProjectShareSheet
          slug={params.project}
          onClose={() => {
            sharing.value = false;
          }}
          onChanged={poll.refresh}
        />
      )}
    </Shell>
  );
}

export const ProjectPage = () => (
  <SignedIn>
    <Project />
  </SignedIn>
);
