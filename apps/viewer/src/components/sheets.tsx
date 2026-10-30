import type { Artifact, VersionRow } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { Check, FileText, Images, X } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useLayoutEffect } from "preact/hooks";
import { useLocation } from "preact-iso";
import { ApiFailure, api, post } from "../api.ts";
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
  // As the sheet appears, not a frame later, so a quick Escape still closes it.
  useLayoutEffect(() => {
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
  const list = usePoll<VersionRow[]>(`/api/artifacts/${artifact.id}/versions`, 60_000);
  const open = useSignal<number | null>(null);
  const naming = useSignal(false);
  const name = useSignal("");
  const error = useSignal<string | null>(null);
  const clean = path.replace(/\/v\/\d+/, "");
  const base = `/${artifact.project}/${artifact.slug}`;
  const canPublish = artifact.permissions.manage && !artifact.archivedAt;

  async function run(work: () => Promise<void>) {
    error.value = null;
    try {
      await work();
    } catch (failure) {
      error.value = failure instanceof ApiFailure ? failure.message : "Something went wrong.";
    }
  }

  return (
    <Sheet title="Version history" onClose={onClose}>
      <div class="group">
        {list.data.value?.map((version) => {
          const current = version.n === artifact.latestVersion;
          return (
            <div key={version.n}>
              <button
                type="button"
                class="vrow"
                aria-expanded={open.value === version.n}
                onClick={() => {
                  open.value = open.value === version.n ? null : version.n;
                  naming.value = false;
                }}
              >
                <b>v{version.n}</b>
                <div class="grow">
                  <div class="tt">{version.name ?? ago(version.publishedAt)}</div>
                  <div class="ss">
                    {version.name ? `${ago(version.publishedAt)}, ` : ""}
                    {agentShort(version.agent ?? version.publishedBy)}
                    {current ? ", current version" : ""}
                  </div>
                </div>
                {version.decision === "approved" && (
                  <span class="word ok">
                    <Check />
                    Approved
                  </span>
                )}
              </button>
              {open.value === version.n && (
                <div class="row" style="padding:0 16px 12px;flex-wrap:wrap;gap:8px">
                  <button
                    type="button"
                    class="btn soft fit"
                    onClick={() => {
                      route(current ? clean : `${clean}?v=${version.n}`);
                      onClose();
                    }}
                  >
                    Preview
                  </button>
                  {canPublish && !current && (
                    <button
                      type="button"
                      class="btn ink fit"
                      onClick={() =>
                        run(async () => {
                          await post(`/api/artifacts/${artifact.id}/versions/${version.n}/restore`);
                          onClose();
                        })
                      }
                    >
                      Restore
                    </button>
                  )}
                  {!current && (
                    <a
                      class="btn soft fit"
                      href={`${base}/compare?from=${version.n}&to=${artifact.latestVersion}`}
                    >
                      Compare
                    </a>
                  )}
                  {canPublish && (
                    <button
                      type="button"
                      class="btn soft fit"
                      onClick={() => {
                        naming.value = !naming.value;
                        name.value = version.name ?? "";
                      }}
                    >
                      Name
                    </button>
                  )}
                  {naming.value && (
                    <form
                      class="row"
                      style="width:100%"
                      onSubmit={(event) => {
                        event.preventDefault();
                        run(async () => {
                          await api(`/api/artifacts/${artifact.id}/versions/${version.n}`, {
                            method: "PATCH",
                            json: { name: name.value || null },
                          });
                          naming.value = false;
                          await list.refresh();
                        });
                      }}
                    >
                      <input
                        class="field grow"
                        aria-label="Version name"
                        value={name.value}
                        onInput={(e) => {
                          name.value = e.currentTarget.value;
                        }}
                      />
                      <button type="submit" class="btn ink fit">
                        Save
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error.value && <p class="err">{error.value}</p>}
    </Sheet>
  );
}
