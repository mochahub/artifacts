import type { Artifact } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Ellipsis,
  FileText,
  History,
  Images,
  Share,
} from "lucide-preact";
import { useRoute } from "preact-iso";
import { AgentMark, StatusWord } from "../components/cards.tsx";
import { ArchivedBanner, ArtifactMenu } from "../components/manage.tsx";
import { DecideSheet } from "../components/review.tsx";
import { ShareSheet } from "../components/share.tsx";
import { VersionSheet } from "../components/sheets.tsx";
import { agentShort, ago, plural } from "../format.ts";
import { usePoll } from "../poll.ts";
import { me } from "../session.ts";
import { Deleted } from "./deleted.tsx";
import { useSignInOn401 } from "./guard.tsx";
import { NotFound } from "./not-found.tsx";

export const artifactPath = (project: string, slug: string) =>
  `/api/artifacts/by-slug/${encodeURIComponent(project)}/${encodeURIComponent(slug)}`;

function Detail() {
  const { params } = useRoute();
  const project = params.project ?? "";
  const remote = usePoll<Artifact>(artifactPath(project, params.artifact ?? ""), 10_000);
  const { data, error } = remote;
  useSignInOn401(error.value?.status);
  const sharing = useSignal(false);
  const menu = useSignal(false);
  const history = useSignal(false);
  const deciding = useSignal(false);

  if (error.value?.status === 410) return <Deleted at={error.value.details.deletedAt as string} />;
  if (error.value?.status === 401) return null;
  if (error.value) return <NotFound />;
  const artifact = data.value;
  if (!artifact) return null;
  const base = `/${artifact.project}/${artifact.slug}`;
  const first = artifact.pages.find((page) => page.changed) ?? artifact.pages[0];
  const changed = artifact.pages.filter((page) => page.changed);

  return (
    <main class="main">
      <div class="top">
        <a class="back" href={`/${artifact.project}`}>
          <ChevronLeft />
          {artifact.project}
        </a>
        {artifact.permissions.share && (
          <button
            type="button"
            class="round"
            aria-label="Share"
            onClick={() => {
              sharing.value = true;
            }}
          >
            <Share />
          </button>
        )}
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
        <button
          type="button"
          class="round"
          aria-label="Version history"
          onClick={() => {
            history.value = true;
          }}
        >
          <History />
        </button>
      </div>
      <ArchivedBanner artifact={artifact} onChanged={() => remote.refresh()} />
      <h1 class="h1">{artifact.title}</h1>
      <div class="row ss">
        {artifact.agent && <AgentMark agent={artifact.agent} small />}
        <span class="grow">
          <b>v{artifact.latestVersion}</b> by {agentShort(artifact.agent ?? artifact.publishedBy)},{" "}
          {ago(artifact.publishedAt)}
        </span>
        <StatusWord card={artifact} />
      </div>
      {changed.length > 0 && (
        <div>
          <div class="changed-h">What changed in v{artifact.latestVersion}</div>
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
              <div class="ss">{page.group ?? (page.kind === "article" ? "Article" : "Canvas")}</div>
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
      <div class="row">
        {first && (
          <a class="btn ink" href={`${base}/${first.key}`}>
            {changed.length > 0 ? "Review changes" : "Start reviewing"}
          </a>
        )}
        {artifact.permissions.comment && me.value && (
          <button
            type="button"
            class="round"
            style="width:52px;height:52px"
            aria-label="Approve or request changes"
            onClick={() => {
              deciding.value = true;
            }}
          >
            <CircleCheck />
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
          onDone={() => {
            deciding.value = false;
            remote.refresh();
          }}
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
    </main>
  );
}

export const ArtifactPage = Detail;
