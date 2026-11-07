import type { Artifact } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { ChevronLeft, ChevronRight, Diff, Ellipsis, FileText, Images } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useLocation, useRoute } from "preact-iso";
import { StatusWord } from "../components/cards.tsx";
import { Gate, Loaded } from "../components/loaded.tsx";
import { ArchivedBanner, ArtifactMenu } from "../components/manage.tsx";
import { LoadFailed, PlaceholderRows } from "../components/placeholder.tsx";
import { ShareSheet } from "../components/share.tsx";
import { Shell } from "../components/shell.tsx";
import { VersionSheet } from "../components/version-sheet.tsx";
import { agentShort, ago, plural } from "../format.ts";
import { artifactApi, artifactHref, projectHref } from "../paths.ts";
import { usePoll } from "../poll.ts";
import { DecideSheet } from "../review/sheets.tsx";
import { me } from "../session.ts";
import { useTitle } from "../title.ts";

const KIND_LABELS: Record<Artifact["pages"][number]["kind"], string> = {
  article: "Article",
  canvas: "Canvas",
  prototype: "Prototype",
  gallery: "Gallery",
  deck: "Deck",
};

export function ArtifactPage() {
  const { params } = useRoute();
  const { route } = useLocation();
  const project = params.project ?? "";
  const remote = usePoll<Artifact>(artifactApi({ project, slug: params.artifact ?? "" }), 10_000);
  // Another artifact's detail must not stand in for this one while it loads: the shape does.
  const artifact = remote.loading ? null : remote.data.value;
  useTitle(artifact?.title);
  const single =
    artifact?.projectKind === "wiki" && artifact.pages.length === 1
      ? artifactHref(artifact, artifact.pages[0]?.key)
      : null;
  useEffect(() => {
    if (single) route(single, true);
  }, [single]);
  if (single) return null;
  const waiting = (inner: ComponentChildren) => (
    <Shell>
      <a class="back" href={projectHref(project)}>
        <ChevronLeft />
        Back
      </a>
      {inner}
    </Shell>
  );
  return (
    <Gate from={[remote]}>
      <Loaded
        from={[remote]}
        value={artifact}
        placeholder={waiting(
          <>
            <span class="ph-line" style="width:70%;height:30px;margin:8px 0" />
            <span class="ph-line short" />
            <PlaceholderRows rows={4} />
          </>,
        )}
        failed={(retry) => waiting(<LoadFailed retry={retry} />)}
      >
        {(artifact) => <Detail artifact={artifact} refresh={remote.refresh} />}
      </Loaded>
    </Gate>
  );
}

function Detail({ artifact, refresh }: { artifact: Artifact; refresh(): Promise<void> }) {
  const sharing = useSignal(false);
  const menu = useSignal(false);
  const history = useSignal(false);
  const deciding = useSignal(false);
  const first = artifact.pages.find((page) => page.changed) ?? artifact.pages[0];
  const changed = artifact.pages.filter((page) => page.changed);
  const canDecide = artifact.permissions.comment && artifact.permissions.decide !== false && me.value;

  return (
    <Shell>
      <div class="top">
        <a class="back" href={projectHref(artifact.project)}>
          <ChevronLeft />
          {artifact.projectName ?? artifact.project}
        </a>
        <button
          type="button"
          class="round"
          aria-label="More"
          onClick={() => {
            menu.value = true;
          }}
        >
          <Ellipsis />
        </button>
      </div>
      <ArchivedBanner artifact={artifact} onChanged={refresh} />
      <h1 class="h1">{artifact.title}</h1>
      <div class="byline">
        <span>
          <button
            type="button"
            class="vchip"
            style="padding:4px 0;min-height:0"
            aria-label="Version history"
            onClick={() => {
              history.value = true;
            }}
          >
            v{artifact.latestVersion}
          </button>{" "}
          by {agentShort(artifact.agent ?? artifact.publishedBy)}, {ago(artifact.publishedAt)}
        </span>
        <StatusWord card={artifact} />
      </div>
      {changed.length > 0 && (
        <div>
          <div class="changed-h row" style="gap:6px">
            <Diff class="chev" style="color:inherit;width:18px;height:18px" />
            What changed in v{artifact.latestVersion}
          </div>
          <div class="ss">{changed.map((page) => page.title ?? page.key).join(", ")}</div>
        </div>
      )}
      <span class="gh">{plural(artifact.pages.length, "page")}</span>
      <div class="group">
        {artifact.pages.map((page) => (
          <a class="li" href={artifactHref(artifact, page.key)} key={page.key}>
            <span class="kind">{page.kind === "article" ? <FileText /> : <Images />}</span>
            <div class="grow">
              <div class="tt">{page.title ?? page.key}</div>
              <div class="ss">{page.group ?? KIND_LABELS[page.kind]}</div>
            </div>
            {page.changed && <span class="dot" title="Changed" />}
            {page.open > 0 && <b class="count">{page.open}</b>}
            <ChevronRight class="chev" />
          </a>
        ))}
      </div>
      <div class="spacer" />
      {artifact.decision && (
        <p class="status-note">
          {artifact.decision.kind === "approved" ? "Approved" : "Changes requested"} on v
          {artifact.decision.version} by {artifact.decision.by}
          {artifact.decision.note ? `: ${artifact.decision.note}` : "."}
        </p>
      )}
      <div class="stack">
        {first && (
          <a class="btn ink" href={artifactHref(artifact, first.key)}>
            {changed.length > 0 ? "Review changes" : "Start reviewing"}
          </a>
        )}
        {canDecide && (
          <button
            type="button"
            class="btn soft"
            onClick={() => {
              deciding.value = true;
            }}
          >
            Approve or request changes
          </button>
        )}
      </div>
      {menu.value && (
        <ArtifactMenu
          artifact={artifact}
          onClose={() => {
            menu.value = false;
          }}
          onChanged={refresh}
          onShare={() => {
            menu.value = false;
            sharing.value = true;
          }}
          onHistory={() => {
            menu.value = false;
            history.value = true;
          }}
        />
      )}
      {sharing.value && (
        <ShareSheet
          artifact={artifact}
          onClose={() => {
            sharing.value = false;
          }}
          onChanged={refresh}
        />
      )}
      {deciding.value && (
        <DecideSheet
          artifact={artifact}
          onClose={() => {
            deciding.value = false;
          }}
          onDone={refresh}
        />
      )}
      {history.value && (
        <VersionSheet
          artifact={artifact}
          onClose={() => {
            history.value = false;
          }}
        />
      )}
    </Shell>
  );
}
