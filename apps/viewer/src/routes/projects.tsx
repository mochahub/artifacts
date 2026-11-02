import type { ProjectRow } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { Search } from "lucide-preact";
import { useLocation } from "preact-iso";
import { ProjectTile, Shell } from "../components/shell.tsx";
import { ago, plural } from "../format.ts";
import { usePoll } from "../poll.ts";
import { SignedIn } from "./guard.tsx";

type Teams = { teams: { slug: string; name: string }[] };

function List() {
  const q = useSignal("");
  const { query, route } = useLocation();
  const team = query.team ?? "";
  const { data } = usePoll<ProjectRow[]>(
    `/api/projects?${new URLSearchParams({ q: q.value, ...(team ? { team } : {}) })}`,
    60_000,
  );
  const teams = usePoll<Teams>("/api/teams", 300_000);
  const choices = teams.data.value?.teams ?? [];
  return (
    <Shell>
      <h1 class="h1 l">Projects</h1>
      <label class="search">
        <Search />
        <input
          placeholder="Search projects"
          aria-label="Search projects"
          value={q.value}
          onInput={(e) => {
            q.value = e.currentTarget.value;
          }}
        />
      </label>
      {choices.length > 0 && (
        <select
          class="sort"
          aria-label="Filter by team"
          value={team}
          onChange={(e) =>
            route(e.currentTarget.value ? `/projects?team=${e.currentTarget.value}` : "/projects")
          }
        >
          <option value="">Every team</option>
          {choices.map((choice) => (
            <option value={choice.slug} key={choice.slug}>
              {choice.name}
            </option>
          ))}
        </select>
      )}
      {data.value && data.value.length > 0 && (
        <div class="group">
          {data.value.map((project) => (
            <a class="li" href={`/${project.slug}`} key={project.id}>
              <ProjectTile name={project.name} />
              <div class="grow">
                <div class="tt">{project.name}</div>
                <div class="ss">
                  {plural(project.artifactCount, "artifact")}, {ago(project.updatedAt)}
                  {project.restricted && ", restricted"}
                </div>
              </div>
              {project.openCount > 0 && <b class="count">{project.openCount}</b>}
            </a>
          ))}
        </div>
      )}
      <p class="fn center">A project appears the first time an agent publishes from its repo.</p>
    </Shell>
  );
}

export const Projects = () => (
  <SignedIn>
    <List />
  </SignedIn>
);
