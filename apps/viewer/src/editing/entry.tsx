import "./entry.css";
import type { Artifact, ArtifactLinks, Attribution, DocState } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { MessageCircle, Pencil } from "lucide-preact";
import type { ComponentType, RefObject } from "preact";
import { useEffect } from "preact/hooks";
import { useLocation } from "preact-iso";
import { api } from "../api.ts";
import { Sheet } from "../components/sheet.tsx";
import { useEvents } from "../events.ts";
import { ago } from "../format.ts";
import { me } from "../session.ts";
import type { Picked, SourceInfo } from "../wiki/attribution.tsx";
import type { EditorProps } from "./editor.tsx";

/**
 * The editor's way in, in the article chunk (13, "Viewer"): the page's DocState, the yellow Edit key,
 * Ask to edit for people who can only comment, the draft line, and the blue pencil in the reader. The
 * editor itself is its own chunk, fetched on the first tap on Edit or with `?edit=1`.
 */
type Wiki = typeof import("../wiki/attribution.tsx");

/** Why a page can't be edited in the browser (13, "Concepts"), in the words a reader sees. */
const NOT_EDITABLE: Record<NonNullable<DocState["reason"]>, string> = {
  not_wiki: "Only wiki pages can be edited in the browser. Publish changes with the CLI.",
  not_article: "This page has more than one article or isn't an article, so it's changed with the CLI.",
  has_backend: "This page has a backend, so it's changed with the CLI.",
  archived: "This page is archived. Bring it back to edit it.",
  redraw: "Republish this page with the CLI to edit it here.",
  no_access: "Editing this page is for people with Can edit.",
};

export function useEditing({
  artifact,
  pageKey,
  version,
  latest,
  body,
  loaded,
  links,
  onComment,
  onRead,
}: {
  artifact: Artifact;
  pageKey: string;
  version: number;
  latest: boolean;
  body: RefObject<HTMLElement | null>;
  loaded: number;
  links: ArtifactLinks | null;
  /** Start a comment from Ask to edit's sheet: on a paragraph, or (to ask) on the page. */
  onComment(ask?: boolean): void;
  /** After the editor closes: the reader loads the latest version again. */
  onRead(): void;
}) {
  const { query } = useLocation();
  const wiki = artifact.projectKind === "wiki";
  const state = useSignal<DocState | null>(null);
  const editor = useSignal<ComponentType<EditorProps> | null>(null);
  const opening = useSignal(false);
  const open = useSignal(false);
  const asking = useSignal(false);
  const why = useSignal(false);
  const attribution = useSignal<Attribution | null>(null);
  const picked = useSignal<Picked | null>(null);
  const pencil = useSignal<Wiki | null>(null);

  const refresh = () => {
    if (!wiki) return;
    api<DocState>(`/api/artifacts/${artifact.id}/doc`).then(
      (value) => {
        state.value = value;
      },
      // A server without editing, or a page that has gone: no Edit key, and reading goes on.
      () => {
        state.value = null;
      },
    );
  };
  useEffect(refresh, [artifact.id, version]);
  useEvents(wiki ? artifact.id : undefined, refresh);

  const start = () => {
    if (editor.value) {
      open.value = true;
      return;
    }
    opening.value = true;
    import("./editor.tsx").then(
      (module) => {
        editor.value = module.Editor;
        open.value = true;
        opening.value = false;
      },
      () => {
        opening.value = false;
      },
    );
  };
  const canEdit = !!state.value?.canEdit && !!state.value.editable && latest;
  useEffect(() => {
    if (canEdit && query.edit === "1" && !open.value) start();
  }, [canEdit]);

  // The pencil: who wrote each passage of this version. The wiki chunk draws it, after the article.
  useEffect(() => {
    if (!wiki) return;
    let live = true;
    attribution.value = null;
    Promise.all([
      api<Attribution>(`/api/artifacts/${artifact.id}/authors?version=${version}`),
      import("../wiki/attribution.tsx"),
    ]).then(
      ([value, module]) => {
        if (!live) return;
        attribution.value = value;
        pencil.value = module;
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [artifact.id, version]);
  useEffect(() => {
    const root = body.current;
    const value = attribution.value;
    const module = pencil.value;
    if (!root || !value || !module || loaded === 0) return;
    module.decorateAuthors(root, value);
    const onClick = (event: MouseEvent) => {
      if (!document.getSelection()?.isCollapsed) return;
      const hit = module.pickedAt(event.target, value);
      if (hit) {
        event.stopPropagation();
        picked.value = hit;
      }
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [attribution.value, pencil.value, loaded]);

  const sources = (slug: string): SourceInfo | null => {
    const link = links?.sources.find((entry) => entry.slug === slug);
    return link
      ? { slug, project: link.project, title: link.title ?? null, untrusted: !!link.untrusted }
      : { slug, project: artifact.project, title: null, untrusted: false };
  };

  const doc = state.value;
  // Someone who can comment on an editable page they can't edit: say so, and offer the way to ask.
  const canAsk = !!doc?.editable && !doc.canEdit && latest && !!me.value && artifact.permissions.comment;
  // A wiki page the browser can't edit: say why, in one plain sentence, where Edit or Ask to edit would be.
  const blocked =
    !!doc &&
    !doc.editable &&
    !!doc.reason &&
    doc.reason !== "not_wiki" &&
    doc.reason !== "no_access" &&
    latest &&
    !!me.value;
  const key = canEdit ? (
    <button type="button" class="btn mark edit-key" onClick={start} disabled={opening.value}>
      <Pencil />
      {opening.value ? "Opening" : "Edit"}
    </button>
  ) : blocked ? (
    <button
      type="button"
      class="btn soft edit-key"
      onClick={() => {
        why.value = true;
      }}
    >
      Not editable here
    </button>
  ) : canAsk ? (
    <button
      type="button"
      class="btn soft edit-key"
      onClick={() => {
        asking.value = true;
      }}
    >
      Ask to edit
    </button>
  ) : null;

  const Editor = editor.value;
  const overlay = (
    <>
      {open.value && Editor && doc && (
        <Editor
          artifact={artifact}
          pageKey={pageKey}
          state={doc}
          sources={sources}
          onClose={() => {
            open.value = false;
            refresh();
            onRead();
          }}
        />
      )}
      {asking.value && (
        <Sheet
          title="You can read and comment"
          onClose={() => {
            asking.value = false;
          }}
        >
          <p class="ss">
            Editing this page is for people with Can edit. Ask, and whoever manages it can add you.
          </p>
          <div class="acts">
            <button
              type="button"
              class="btn soft"
              onClick={() => {
                asking.value = false;
                onComment();
              }}
            >
              <MessageCircle />
              Comment
            </button>
            <button
              type="button"
              class="btn mark"
              onClick={() => {
                asking.value = false;
                onComment(true);
              }}
            >
              Ask to edit
            </button>
          </div>
        </Sheet>
      )}
      {why.value && doc?.reason && (
        <Sheet
          title="This page is edited with the CLI"
          onClose={() => {
            why.value = false;
          }}
        >
          <p class="ss">{NOT_EDITABLE[doc.reason]}</p>
        </Sheet>
      )}
      {picked.value && pencil.value && (
        <pencil.value.AuthorPopover
          picked={picked.value}
          version={version}
          sources={sources}
          onClose={() => {
            picked.value = null;
          }}
        />
      )}
    </>
  );

  // Editors see that the page has moved on since this version. Readers who can't edit never do.
  const banner =
    canEdit && doc?.dirty ? (
      <div class="banner draft-line" style="margin-bottom:16px">
        <Pencil class="chev" style="color:var(--mark-word)" />
        <span class="grow">
          Draft: changes since v{doc.version}
          {doc.updatedAt ? `, ${ago(doc.updatedAt)}` : ""}.
        </span>
        <button type="button" class="vchip" onClick={start}>
          Open
        </button>
      </div>
    ) : null;

  return { state: doc, key, overlay, banner, editing: open.value };
}
