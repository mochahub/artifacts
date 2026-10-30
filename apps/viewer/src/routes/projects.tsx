import type { ProjectRow } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { Search } from "lucide-preact";
import { ProjectTile, Shell } from "../components/shell.tsx";
import { ago, plural } from "../format.ts";
import { usePoll } from "../poll.ts";
import { SignedIn } from "./guard.tsx";

function List() {
  const q = useSignal("");
  const { data } = usePoll<ProjectRow[]>(`/api/projects?q=${encodeURIComponent(q.value)}`, 60_000);
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
      {data.value && data.value.length > 0 && (
        <div class="group">
          {data.value.map((project) => (
            <a class="li" href={`/${project.slug}`} key={project.id}>
              <ProjectTile name={project.name} />
              <div class="grow">
                <div class="tt">{project.name}</div>
                <div class="ss">
                  {plural(project.artifactCount, "artifact")}, {ago(project.updatedAt)}
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
