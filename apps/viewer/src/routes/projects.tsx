import type { ProjectRow, TeamList } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { ChevronsUpDown, Search } from "lucide-preact";
import { useLocation } from "preact-iso";
import { SignedIn } from "../components/guard.tsx";
import { Loaded } from "../components/loaded.tsx";
import { PlaceholderRows } from "../components/placeholder.tsx";
import { ProjectTile, Shell } from "../components/shell.tsx";
import { ago, plural } from "../format.ts";
import { projectHref } from "../paths.ts";
import { usePoll } from "../poll.ts";
import { useTitle } from "../title.ts";

function List() {
  const q = useSignal("");
  const { query, route } = useLocation();
  const team = query.team ?? "";
  const poll = usePoll<ProjectRow[]>(
    `/api/projects?${new URLSearchParams({ q: q.value, ...(team ? { team } : {}) })}`,
    60_000,
  );
  useTitle("Projects");
  const teams = usePoll<TeamList>("/api/teams", 300_000);
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
        <label class="sort" style="align-self:flex-start">
          <select
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
          <ChevronsUpDown />
        </label>
      )}
      <Loaded from={[poll]} value={poll.data.value} placeholder={<PlaceholderRows rows={3} />}>
        {(projects) =>
          projects.length > 0 ? (
            <div class="group">
              {projects.map((project) => (
                <a class="li" href={projectHref(project.slug)} key={project.id}>
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
          ) : (
            !q.value && (
              <p class="fn center">A project appears the first time an agent publishes from its repo.</p>
            )
          )
        }
      </Loaded>
    </Shell>
  );
}

export const Projects = () => (
  <SignedIn>
    <List />
  </SignedIn>
);
