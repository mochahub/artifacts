import type { Artifact } from "@artifacts/schema";
import { FileText, Images } from "lucide-preact";
import { artifactHref } from "../paths.ts";
import { Sheet } from "./sheet.tsx";

/** Every page, grouped as in the manifest, with changed dots and open counts (01·5). */
export function PageSwitcher({
  artifact,
  current,
  onClose,
}: {
  artifact: Artifact;
  current: string;
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
                href={artifactHref(artifact, page.key)}
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
