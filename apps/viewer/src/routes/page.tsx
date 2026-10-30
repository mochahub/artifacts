import type { Artifact, Thread } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { lazy, useLocation, useRoute } from "preact-iso";
import type { ArticlePage } from "../article/view.tsx";
import type { CanvasPage } from "../canvas/view.tsx";
import { PageSwitcher, VersionSheet } from "../components/sheets.tsx";
import { usePoll } from "../poll.ts";
import { artifactPath } from "./artifact.tsx";
import { Deleted } from "./deleted.tsx";
import { useSignInOn401 } from "./guard.tsx";
import { NotFound } from "./not-found.tsx";

const CanvasView = lazy(() => import("../canvas/view.tsx").then((m) => m.CanvasView));
const ArticleView = lazy(() => import("../article/view.tsx").then((m) => m.ArticleView));

type Version = { n: number; pages: ((CanvasPage | ArticlePage) & { kind: string })[] };

function Page() {
  const { params } = useRoute();
  const { query } = useLocation();
  const project = params.project ?? "";
  const slug = params.artifact ?? "";
  const remote = usePoll<Artifact>(artifactPath(project, slug), 10_000);
  const artifact = remote.data.value;
  useSignInOn401(remote.error.value?.status);
  const pinned = Number(params.n ?? query.v) || null;
  const version = pinned ?? artifact?.latestVersion ?? null;
  const detail = usePoll<Version>(
    artifact && version ? `/api/artifacts/${artifact.id}/versions/${version}` : null,
    3_600_000,
  );
  const threads = usePoll<Thread[]>(artifact ? `/api/artifacts/${artifact.id}/threads` : null, 10_000);
  const pages = useSignal(false);
  const versions = useSignal(false);

  if (remote.error.value?.status === 410)
    return <Deleted at={remote.error.value.details.deletedAt as string} />;
  if (remote.error.value?.status === 401) return null;
  if (remote.error.value || detail.error.value) return <NotFound />;
  if (!artifact || !detail.data.value || !version) return null;
  const key = params.page ?? artifact.pages[0]?.key;
  const page = detail.data.value.pages.find((entry) => entry.key === key);
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
      {page.kind === "article" ? (
        <ArticleView artifact={artifact} page={page as ArticlePage} version={version} {...chrome} />
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
