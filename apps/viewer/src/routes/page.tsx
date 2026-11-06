import type { Artifact, Thread } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { lazy, useLocation, useRoute } from "preact-iso";
import type { ArticlePage } from "../article/view.tsx";
import type { CanvasPage } from "../canvas/view.tsx";
import { Gate, Loaded, NotFound } from "../components/loaded.tsx";
import { PageSwitcher } from "../components/page-switcher.tsx";
import { LoadFailed, PlaceholderPage } from "../components/placeholder.tsx";
import { VersionSheet } from "../components/version-sheet.tsx";
import { useEvents } from "../events.ts";
import type { GalleryPage } from "../gallery/view.tsx";
import type { PrototypePage } from "../live/prototype.tsx";
import { artifactApi } from "../paths.ts";
import { type Remote, usePoll } from "../poll.ts";
import { useTitle } from "../title.ts";

const PrototypeView = lazy(() => import("../live/prototype.tsx").then((m) => m.PrototypeView));
const CanvasView = lazy(() => import("../canvas/view.tsx").then((m) => m.CanvasView));
const ArticleView = lazy(() => import("../article/view.tsx").then((m) => m.ArticleView));
const GalleryView = lazy(() => import("../gallery/view.tsx").then((m) => m.GalleryView));

type Version = {
  n: number;
  previous?: number | null;
  pages: ((CanvasPage | ArticlePage) & { kind: string })[];
};

export function PageRoute() {
  const { params } = useRoute();
  const { query } = useLocation();
  const remote = usePoll<Artifact>(
    artifactApi({ project: params.project ?? "", slug: params.artifact ?? "" }),
    10_000,
  );
  // Another artifact's answer must not stand in for this one while it loads.
  const artifact = remote.loading ? null : remote.data.value;
  const pinned = Number(params.n ?? query.v) || null;
  const version = pinned ?? artifact?.latestVersion ?? null;
  const detail = usePoll<Version>(
    artifact && version ? `/api/artifacts/${artifact.id}/versions/${version}` : null,
    3_600_000,
  );
  const threads = usePoll<Thread[]>(artifact ? `/api/artifacts/${artifact.id}/threads` : null, 10_000);
  useEvents(artifact?.id, () => {
    remote.refresh();
    threads.refresh();
  });
  const loaded = detail.loading ? null : detail.data.value;
  const key = params.page ?? artifact?.pages[0]?.key;
  const page = loaded?.pages.find((entry) => entry.key === key);
  useTitle(page?.title ?? (page ? page.key : null), artifact?.title);

  return (
    <Gate from={[remote, detail]}>
      <Loaded
        from={[remote, detail]}
        // Threads load beside the detail; the last artifact's pins must not land on this one's frames.
        value={artifact && loaded && version && !threads.loading ? { artifact, loaded, version } : null}
        placeholder={<PlaceholderPage />}
        failed={(retry) => (
          <main class="screen">
            <LoadFailed retry={retry} />
          </main>
        )}
      >
        {({ artifact, loaded, version }) =>
          page ? (
            <PageView
              artifact={artifact}
              page={page}
              version={version}
              previous={loaded.previous ?? null}
              threads={threads}
            />
          ) : (
            <NotFound />
          )
        }
      </Loaded>
    </Gate>
  );
}

function PageView({
  artifact,
  page,
  version,
  previous,
  threads,
}: {
  artifact: Artifact;
  page: Version["pages"][number];
  version: number;
  previous: number | null;
  threads: Remote<Thread[]>;
}) {
  const pages = useSignal(false);
  const versions = useSignal(false);
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
          previous={previous}
          {...chrome}
        />
      ) : (
        <CanvasView artifact={artifact} page={page as CanvasPage} version={version} {...chrome} />
      )}
      {pages.value && (
        <PageSwitcher
          artifact={artifact}
          current={page.key}
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
