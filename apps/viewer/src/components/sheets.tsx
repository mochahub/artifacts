import type { Artifact, VersionRow } from "@artifacts/schema";
import { Check, FileText, Images, X } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useLocation } from "preact-iso";
import { agentShort, ago } from "../format.ts";
import { usePoll } from "../poll.ts";

export function Sheet({
  title,
  onClose,
  children,
  extra,
}: {
  title: string;
  onClose(): void;
  children: ComponentChildren;
  extra?: ComponentChildren;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div class="dim" onClick={onClose} aria-hidden="true" />
      <div class="sheet" role="dialog" aria-label={title}>
        <div class="grabber" />
        <div class="shead">
          <div class="t">{title}</div>
          {extra}
          <button type="button" class="x" aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

/** Every page, grouped as in the manifest, with changed dots and open counts (01·5). */
export function PageSwitcher({
  artifact,
  current,
  base,
  onClose,
}: {
  artifact: Artifact;
  current: string;
  base: string;
  onClose(): void;
}) {
  const groups = new Map<string | null, Artifact["pages"]>();
  for (const page of artifact.pages) groups.set(page.group, [...(groups.get(page.group) ?? []), page]);
  return (
    <Sheet
      title={artifact.title}
      onClose={onClose}
      extra={<span class="vchip">v{artifact.latestVersion}</span>}
    >
      {[...groups.entries()].map(([group, pages]) => (
        <>
          {group && (
            <span class="gh split">
              <span>{group}</span>
              <span>{pages.length}</span>
            </span>
          )}
          <div class="group" key={group}>
            {pages.map((page, index) => (
              <a
                class={`li${page.key === current ? " on" : ""}`}
                href={`${base}/${page.key}`}
                onClick={onClose}
                key={page.key}
              >
                {group ? (
                  <span class="fn num">{String(index + 1).padStart(2, "0")}</span>
                ) : (
                  <span class="kind">{page.kind === "article" ? <FileText /> : <Images />}</span>
                )}
                <div class="grow">
                  <div class="tt">{page.title ?? page.key}</div>
                </div>
                {page.changed && <span class="dot" title="Changed" />}
                {page.open > 0 && <b class="count">{page.open}</b>}
              </a>
            ))}
          </div>
        </>
      ))}
    </Sheet>
  );
}

export function VersionSheet({ artifact, onClose }: { artifact: Artifact; onClose(): void }) {
  const { route, path } = useLocation();
  const { data } = usePoll<VersionRow[]>(`/api/artifacts/${artifact.id}/versions`, 60_000);
  const clean = path.replace(/\/v\/\d+/, "");
  return (
    <Sheet title="Version history" onClose={onClose}>
      <div class="group">
        {data.value?.map((version) => (
          <button
            type="button"
            class="vrow"
            key={version.n}
            onClick={() => {
              route(version.n === artifact.latestVersion ? clean : `${clean}?v=${version.n}`);
              onClose();
            }}
          >
            <b>v{version.n}</b>
            <div class="grow">
              <div class="tt">{version.name ?? ago(version.publishedAt)}</div>
              <div class="ss">
                {version.name ? `${ago(version.publishedAt)}, ` : ""}
                {agentShort(version.agent ?? version.publishedBy)}
                {version.n === artifact.latestVersion ? ", current version" : ""}
              </div>
            </div>
            {version.decision === "approved" && (
              <span class="word ok">
                <Check />
                Approved
              </span>
            )}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
