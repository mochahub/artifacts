import type { Artifact, Thread } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { tapped } from "../notify.ts";
import type { Remote } from "../poll.ts";
import { CommentSheet, CommentsPanel, CommentsSheet, type Draft, ThreadSheet } from "./sheets.tsx";

type Options = {
  artifact: Artifact;
  page: string;
  version: number;
  threads: Remote<Thread[]>;
  /** The page or frame a thread sits on, under its title in the sheet. */
  where(thread: Thread): string;
  /** After a thread opens from a list or a `?c=` link, such as flying the canvas to its frame. */
  onShow?(thread: Thread, from: "list" | "link"): void;
  /** Whether posting a comment opens its thread. The canvas does, so the new pin is the active one. */
  openPosted?: boolean;
};

/**
 * One page's review: its threads, the one open, a draft, and the sheets for them (06). The page puts
 * `sheets` in its markup and starts a draft or opens a thread with the signals.
 */
export function useReview<D extends Draft = Draft>({
  artifact,
  page,
  version,
  threads,
  where,
  onShow,
  openPosted,
}: Options) {
  const openId = useSignal<string | null>(null);
  const listOpen = useSignal(false);
  const draft = useSignal<D | null>(null);
  const all = (threads.data.value ?? []).filter((thread) => thread.pageKey === page);
  const openThread = all.find((thread) => thread.id === openId.value) ?? null;
  const openCount = all.filter((thread) => thread.status === "open").length;
  const show = (thread: Thread) => {
    listOpen.value = false;
    openId.value = thread.id;
    onShow?.(thread, "list");
  };

  // ?c=<n> opens a thread, once for each link or tapped notification.
  const deepLinked = useRef("");
  const link = `${location.search}/${tapped.value}`;
  useEffect(() => {
    const n = Number(new URLSearchParams(location.search).get("c"));
    if (deepLinked.current === link || !n || all.length === 0) return;
    const thread = all.find((entry) => entry.n === n);
    if (!thread) return;
    deepLinked.current = link;
    openId.value = thread.id;
    onShow?.(thread, "link");
  });

  const sheets = (
    <>
      <CommentsPanel artifact={artifact} threads={all} onOpen={show} />
      {draft.value && (
        <CommentSheet
          artifact={artifact}
          version={version}
          draft={draft.value}
          onClose={() => {
            draft.value = null;
          }}
          onPosted={async (thread) => {
            draft.value = null;
            await threads.refresh();
            if (openPosted) openId.value = thread.id;
          }}
        />
      )}
      {openThread && (
        <ThreadSheet
          artifact={artifact}
          thread={openThread}
          subtitle={where(openThread)}
          threads={threads}
          onClose={() => {
            openId.value = null;
          }}
        />
      )}
      {listOpen.value && (
        <CommentsSheet
          artifact={artifact}
          threads={all}
          onOpen={show}
          onClose={() => {
            listOpen.value = false;
          }}
        />
      )}
    </>
  );
  return { all, openId, openCount, draft, listOpen, sheets };
}
