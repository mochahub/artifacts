import type { ProjectArtifacts } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { ChevronLeft, Search, Share } from "lucide-preact";
import { useRoute } from "preact-iso";
import { ArtifactTile } from "../components/cards.tsx";
import { ProjectShareSheet } from "../components/share.tsx";
import { Shell } from "../components/shell.tsx";
import { usePoll } from "../poll.ts";
import { meta } from "../session.ts";
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
  const sharing = useSignal(false);
  const { data, error, refresh } = usePoll<ProjectArtifacts>(
    `/api/projects/${encodeURIComponent(params.project ?? "")}/artifacts?${query}`,
    60_000,
  );
  if (error.value?.status === 404) return <NotFound />;
  const project = data.value?.project;
  return (
    <Shell wide>
      <a class="back" href="/projects">
        <ChevronLeft />
        Projects
      </a>
      <div>
        <div class="row">
          <h1 class="h1 grow">{project?.name}</h1>
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
      <label class="search">
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
        <select
          class="sort"
          aria-label="Sort"
          value={sort.value}
          onChange={(e) => {
            sort.value = e.currentTarget.value;
          }}
        >
          <option value="recent">Recent</option>
          <option value="name">Name</option>
        </select>
      </div>
      <div class="grid">
        {data.value?.artifacts.map((card) => (
          <ArtifactTile card={card} key={card.id} />
        ))}
      </div>
      {data.value?.artifacts.length === 0 && <div class="empty">Nothing here.</div>}
      {sharing.value && params.project && (
        <ProjectShareSheet
          slug={params.project}
          onClose={() => {
            sharing.value = false;
          }}
          onChanged={refresh}
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
