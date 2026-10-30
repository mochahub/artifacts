import type { Home as HomeData, ProjectRow } from "@artifacts/schema";
import { Bell, Folder, Inbox, Search } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useLocation } from "preact-iso";
import { initials } from "../format.ts";
import { usePoll } from "../poll.ts";
import { meta } from "../session.ts";

const TABS = [
  { href: "/", label: "Review", Icon: Inbox },
  { href: "/projects", label: "Projects", Icon: Folder },
  { href: "/activity", label: "Activity", Icon: Bell },
  { href: "/search", label: "Search", Icon: Search },
];

/** Tab bar on phones, a left rail on desktop (boards 01 and 04). */
export function Shell({ children, wide }: { children: ComponentChildren; wide?: boolean }) {
  const { path } = useLocation();
  const home = usePoll<HomeData>("/api/home", 60_000);
  const projects = usePoll<ProjectRow[]>("/api/projects", 60_000);
  const waiting = home.data.value?.waiting.length ?? 0;
  return (
    <div class="app">
      <nav class="rail" aria-label="Main">
        <div class="brand">
          <span class="logo" />
          {meta.value?.orgName}
        </div>
        {TABS.map(({ href, label, Icon }) => (
          <a href={href} key={href} aria-current={path === href ? "page" : undefined}>
            <Icon />
            {label}
          </a>
        ))}
        {(projects.data.value?.length ?? 0) > 0 && <div class="rh">Projects</div>}
        {projects.data.value?.map((project) => (
          <a
            href={`/${project.slug}`}
            key={project.id}
            aria-current={path === `/${project.slug}` ? "page" : undefined}
          >
            {project.name}
          </a>
        ))}
      </nav>
      <main class={`main${wide ? " wide" : ""}`}>{children}</main>
      <nav class="tabbar glass" aria-label="Main">
        {TABS.map(({ href, label, Icon }) => (
          <a class="tab" href={href} key={href} aria-current={path === href ? "page" : undefined}>
            <Icon />
            {label}
            {href === "/" && waiting > 0 && <b class="count">{waiting}</b>}
          </a>
        ))}
      </nav>
    </div>
  );
}

export const ProjectTile = ({ name }: { name: string }) => <span class="kind">{initials(name)}</span>;
