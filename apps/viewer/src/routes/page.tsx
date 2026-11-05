import type { Artifact, Thread } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { lazy, useLocation, useRoute } from "preact-iso";
import { isMissing } from "../api.ts";
import type { ArticlePage } from "../article/view.tsx";
import type { CanvasPage } from "../canvas/view.tsx";
import { LoadFailed, PlaceholderPage } from "../components/placeholder.tsx";
import { PageSwitcher, VersionSheet } from "../components/sheets.tsx";
import { useEvents } from "../events.ts";
import type { PrototypePage } from "../live/prototype.tsx";
import { usePoll } from "../poll.ts";
import { useTitle } from "../title.ts";
import { artifactPath } from "./artifact.tsx";
import { Deleted } from "./deleted.tsx";
import { type GalleryPage, GalleryView } from "./gallery.tsx";
import { useSignInOn401 } from "./guard.tsx";
import { NotFound } from "./not-found.tsx";

const PrototypeView = lazy(() => import("../live/prototype.tsx").then((m) => m.PrototypeView));
const CanvasView = lazy(() => import("../canvas/view.tsx").then((m) => m.CanvasView));
const ArticleView = lazy(() => import("../article/view.tsx").then((m) => m.ArticleView));

type Version = {
  n: number;
  previous?: number | null;
  pages: ((CanvasPage | ArticlePage) & { kind: string })[];
};

function Page() {
  const { params } = useRoute();
  const { query } = useLocation();
  const project = params.project ?? "";
  const slug = params.artifact ?? "";
  const remote = usePoll<Artifact>(artifactPath(project, slug), 10_000);
  // Another artifact's answer must not stand in for this one while it loads.
  const artifact = remote.loading ? null : remote.data.value;
  useSignInOn401(remote.error.value?.status);
  const pinned = Number(params.n ?? query.v) || null;
  const version = pinned ?? artifact?.latestVersion ?? null;
  const detail = usePoll<Version>(
    artifact && version ? `/api/artifacts/${artifact.id}/versions/${version}` : null,
    3_600_000,
  );
  const threads = usePoll<Thread[]>(artifact ? `/api/artifacts/${artifact.id}/threads` : null, 10_000);
  useEvents(artifact?.id, () => {
    remote.refresh().catch(() => {});
    threads.refresh().catch(() => {});
  });
  const pages = useSignal(false);
  const versions = useSignal(false);
  const loaded = detail.loading ? null : detail.data.value;
  const key = params.page ?? artifact?.pages[0]?.key;
  const page = loaded?.pages.find((entry) => entry.key === key);
  useTitle(page?.title ?? (page ? page.key : null), artifact?.title);

  if (remote.error.value?.status === 410)
    return <Deleted at={remote.error.value.details.deletedAt as string} />;
  if (remote.error.value?.status === 401) return null;
  if (isMissing(remote.error.value) || isMissing(detail.error.value)) return <NotFound />;
  // Threads load beside the detail; the last artifact's pins must not land on this one's frames.
  if (!artifact || !loaded || !version || threads.loading) {
    const failed = (remote.error.value || detail.error.value) && !remote.loading && !detail.loading;
    return failed ? (
      <main class="screen">
        <LoadFailed
          retry={() => {
            remote.refresh().catch(() => {});
            detail.refresh().catch(() => {});
          }}
        />
      </main>
    ) : (
      <PlaceholderPage />
    );
  }
  if (!page) return <NotFound />;

  const chrome = {
    threads,
    latest: version === artifact.latestVersion,
    onPages() {
      pages.value = true;
    },
    onVersions() {
      versions.value = true;
    },
  };
  return (
    <>
      {page.kind === "prototype" ? (
        <PrototypeView
          artifact={artifact}
          page={page as unknown as PrototypePage}
          version={version}
          onPages={chrome.onPages}
          onVersions={chrome.onVersions}
        />
      ) : page.kind === "gallery" ? (
        <GalleryView
          artifact={artifact}
          page={page as unknown as GalleryPage}
          version={version}
          onPages={chrome.onPages}
          onVersions={chrome.onVersions}
        />
      ) : page.kind === "article" ? (
        <ArticleView
          artifact={artifact}
          page={page as ArticlePage}
          version={version}
          previous={loaded.previous ?? null}
          {...chrome}
        />
      ) : (
        <CanvasView artifact={artifact} page={page as CanvasPage} version={version} {...chrome} />
      )}
      {pages.value && (
        <PageSwitcher
          artifact={artifact}
          current={page.key}
          base={`/${artifact.project}/${artifact.slug}`}
          onClose={() => {
            pages.value = false;
          }}
        />
      )}
      {versions.value && (
        <VersionSheet
          artifact={artifact}
          onClose={() => {
            versions.value = false;
          }}
        />
      )}
    </>
  );
}

export const PageRoute = Page;
