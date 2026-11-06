import type { Home as HomeData, ProjectRow } from "@artifacts/schema";
import { Bell, Folder, Inbox, Menu, Search } from "lucide-preact";
import type { ComponentChildren, Ref } from "preact";
import { useLocation } from "preact-iso";
import { initials } from "../format.ts";
import { projectHref } from "../paths.ts";
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
            href={projectHref(project.slug)}
            key={project.id}
            aria-current={path === projectHref(project.slug) ? "page" : undefined}
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

/** The floating bar over every page: the page switcher, where you are, and the version (board 01). */
export function PageCapsule({
  title,
  subtitle,
  version,
  onPages,
  onVersions,
  liquid,
  box,
  children,
}: {
  title: string;
  subtitle: string;
  version: number;
  onPages(): void;
  onVersions(): void;
  /** The reader's Liquid Glass (article/liquid.ts), which needs the element too. */
  liquid?: boolean;
  box?: Ref<HTMLDivElement>;
  children?: ComponentChildren;
}) {
  return (
    <div ref={box} class={`capsule glass${liquid ? " liquid" : ""}`}>
      <button type="button" class="icon-btn" aria-label="Pages" onClick={onPages}>
        <Menu />
      </button>
      <button type="button" class="where" onClick={onPages}>
        <b>{title}</b>
        <span>{subtitle}</span>
      </button>
      <button type="button" class="vchip" aria-label="Version history" onClick={onVersions}>
        v{version}
      </button>
      {children}
    </div>
  );
}
