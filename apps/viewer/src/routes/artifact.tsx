import type { Artifact } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { ChevronLeft, ChevronRight, Diff, Ellipsis, FileText, Images } from "lucide-preact";
import { useRoute } from "preact-iso";
import { isMissing } from "../api.ts";
import { StatusWord } from "../components/cards.tsx";
import { ArchivedBanner, ArtifactMenu } from "../components/manage.tsx";
import { LoadFailed, PlaceholderRows } from "../components/placeholder.tsx";
import { DecideSheet } from "../components/review.tsx";
import { ShareSheet } from "../components/share.tsx";
import { VersionSheet } from "../components/sheets.tsx";
import { Shell } from "../components/shell.tsx";
import { agentShort, ago, plural } from "../format.ts";
import { usePoll } from "../poll.ts";
import { me } from "../session.ts";
import { useTitle } from "../title.ts";
import { Deleted } from "./deleted.tsx";
import { useSignInOn401 } from "./guard.tsx";
import { NotFound } from "./not-found.tsx";

export const artifactPath = (project: string, slug: string) =>
  `/api/artifacts/by-slug/${encodeURIComponent(project)}/${encodeURIComponent(slug)}`;

const KIND_LABELS: Record<Artifact["pages"][number]["kind"], string> = {
  article: "Article",
  canvas: "Canvas",
  prototype: "Prototype",
  gallery: "Gallery",
  deck: "Deck",
};

function Detail() {
  const { params } = useRoute();
  const project = params.project ?? "";
  const remote = usePoll<Artifact>(artifactPath(project, params.artifact ?? ""), 10_000);
  const { data, error, loading } = remote;
  useSignInOn401(error.value?.status);
  const sharing = useSignal(false);
  const menu = useSignal(false);
  const history = useSignal(false);
  const deciding = useSignal(false);
  // Another artifact's detail must not stand in for this one while it loads: the shape does.
  const artifact = loading ? null : data.value;
  useTitle(artifact?.title);

  if (error.value?.status === 410) return <Deleted at={error.value.details.deletedAt as string} />;
  if (error.value?.status === 401) return null;
  if (isMissing(error.value)) return <NotFound />;
  if (!artifact) {
    return (
      <Shell>
        <a class="back" href={`/${project}`}>
          <ChevronLeft />
          Back
        </a>
        {error.value && !loading ? (
          <LoadFailed retry={() => remote.refresh().catch(() => {})} />
        ) : (
          <>
            <span class="ph-line" style="width:70%;height:30px;margin:8px 0" />
            <span class="ph-line short" />
            <PlaceholderRows rows={4} />
          </>
        )}
      </Shell>
    );
  }
  const base = `/${artifact.project}/${artifact.slug}`;
  const first = artifact.pages.find((page) => page.changed) ?? artifact.pages[0];
  const changed = artifact.pages.filter((page) => page.changed);
  const canDecide = artifact.permissions.comment && artifact.permissions.decide !== false && me.value;

  return (
    <Shell>
      <div class="top">
        <a class="back" href={`/${artifact.project}`}>
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
      <ArchivedBanner artifact={artifact} onChanged={() => remote.refresh()} />
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
          <a class="li" href={`${base}/${page.key}`} key={page.key}>
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
          <a class="btn ink" href={`${base}/${first.key}`}>
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
          onChanged={() => remote.refresh()}
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
          onChanged={() => remote.refresh()}
        />
      )}
      {deciding.value && (
        <DecideSheet
          artifact={artifact}
          onClose={() => {
            deciding.value = false;
          }}
          onDone={() => remote.refresh()}
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

export const ArtifactPage = Detail;
