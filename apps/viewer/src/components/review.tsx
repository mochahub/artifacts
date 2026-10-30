import type { Anchor, Artifact, Comment, Thread } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { Check, X } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import { ApiFailure, api, post } from "../api.ts";
import { agentInitials, agentShort, ago } from "../format.ts";
import type { Remote } from "../poll.ts";
import { me } from "../session.ts";
import { Sheet } from "./sheets.tsx";

const message = (failure: unknown) =>
  failure instanceof ApiFailure ? failure.message : "Something went wrong.";

/** Keeps a sheet on top of the on-screen keyboard (06). */
function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const place = () => {
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      document.documentElement.style.setProperty("--keyboard", `${Math.max(10, covered + 10)}px`);
    };
    place();
    viewport.addEventListener("resize", place);
    viewport.addEventListener("scroll", place);
    return () => {
      viewport.removeEventListener("resize", place);
      viewport.removeEventListener("scroll", place);
      document.documentElement.style.removeProperty("--keyboard");
    };
  }, []);
}

export type Draft = { pageKey: string; anchor: Anchor | null; where: string; quote?: string };

export function CommentSheet({
  artifact,
  version,
  draft,
  onClose,
  onPosted,
}: {
  artifact: Artifact;
  version: number;
  draft: Draft;
  onClose(): void;
  onPosted(thread: Thread): void;
}) {
  useKeyboardInset();
  const body = useSignal("");
  const error = useSignal<string | null>(null);
  const busy = useSignal(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);

  async function submit() {
    busy.value = true;
    try {
      onPosted(
        await post<Thread>(`/api/artifacts/${artifact.id}/threads`, {
          pageKey: draft.pageKey,
          anchor: draft.anchor,
          body: body.value,
          version,
        }),
      );
    } catch (failure) {
      error.value = message(failure);
      busy.value = false;
    }
  }

  return (
    <div class="compose" role="dialog" aria-label="New comment">
      <div class="shead">
        <div class="t grow">
          New comment
          <span class="fn">
            {draft.where}, v{version}
          </span>
        </div>
        <button type="button" class="x" aria-label="Close" onClick={onClose}>
          <X />
        </button>
      </div>
      {draft.quote && <div class="quote">{draft.quote}</div>}
      <textarea
        ref={field}
        aria-label="Comment"
        value={body.value}
        onInput={(e) => {
          body.value = e.currentTarget.value;
        }}
      />
      {error.value && <p class="err">{error.value}</p>}
      <div class="actions">
        <button type="button" class="btn soft fit" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          class="btn mark fit"
          disabled={busy.value || !body.value.trim()}
          onClick={submit}
        >
          Post
        </button>
      </div>
    </div>
  );
}

function Message({ comment }: { comment: Comment }) {
  const agent = comment.agent;
  return (
    <div class="msg">
      {agent ? (
        <span class="av agent">{agentInitials(agent)}</span>
      ) : (
        <span class={`av${comment.author.name === me.value?.name ? " you" : ""}`}>
          {comment.author.name[0]}
        </span>
      )}
      <div class="grow">
        <div class="name">
          {agent ? agentShort(agent) : comment.author.name}
          <span>
            {comment.marksFixed ? "fixed in" : "on"} v{comment.version}, {ago(comment.createdAt)}
          </span>
        </div>
        <p>{comment.body}</p>
      </div>
    </div>
  );
}

const stateNote = (thread: Thread) =>
  thread.anchorState === "updated"
    ? "Changed since this comment."
    : thread.anchorState === "orphaned"
      ? `What this pointed at is gone. See it in v${thread.createdVersion}.`
      : thread.anchorState === "moved_version"
        ? "Made on a removed version."
        : null;

export function ThreadSheet({
  artifact,
  thread,
  title,
  base,
  threads,
  onClose,
}: {
  artifact: Artifact;
  thread: Thread;
  title: string;
  base: string;
  threads: Remote<Thread[]>;
  onClose(): void;
}) {
  const reply = useSignal("");
  const error = useSignal<string | null>(null);
  const canAct = artifact.permissions.comment;

  async function run(work: () => Promise<unknown>) {
    error.value = null;
    try {
      await work();
      await threads.refresh();
    } catch (failure) {
      error.value = message(failure);
    }
  }
  const send = () =>
    run(async () => {
      await post(`/api/threads/${thread.id}/comments`, { body: reply.value });
      reply.value = "";
    });

  return (
    <Sheet
      title={title}
      onClose={onClose}
      extra={
        <>
          {thread.status === "fixed" && <span class="word agent">Fixed in v{thread.fixedVersion}</span>}
          {thread.status === "resolved" && <span class="word ok">Resolved</span>}
        </>
      }
    >
      {thread.anchor?.type === "text" && <div class="quote">{thread.anchor.quote.exact}</div>}
      {stateNote(thread) && <p class="status-note">{stateNote(thread)}</p>}
      {thread.comments.map((comment) => (
        <Message comment={comment} key={comment.id} />
      ))}
      {thread.crop && <img class="crop" src={thread.crop} alt="The area this comment points at" />}
      {thread.fixedVersion && thread.fixedVersion > thread.createdVersion && (
        <a
          class="word agent"
          href={`${base}/compare?from=${thread.createdVersion}&to=${thread.fixedVersion}`}
        >
          Compare v{thread.createdVersion} and v{thread.fixedVersion}
        </a>
      )}
      {error.value && <p class="err">{error.value}</p>}
      {canAct && (
        <div class="replybox">
          <textarea
            aria-label="Reply"
            placeholder="Reply"
            value={reply.value}
            onInput={(e) => {
              reply.value = e.currentTarget.value;
            }}
          />
          {reply.value.trim() ? (
            <button type="button" class="btn mark fit" onClick={send}>
              Send
            </button>
          ) : thread.status === "resolved" ? (
            <button
              type="button"
              class="btn soft fit"
              onClick={() => run(() => post(`/api/threads/${thread.id}/reopen`))}
            >
              Reopen
            </button>
          ) : (
            me.value && (
              <button
                type="button"
                class="btn mark fit"
                onClick={() => run(() => post(`/api/threads/${thread.id}/resolve`))}
              >
                <Check />
                Resolve
              </button>
            )
          )}
        </div>
      )}
    </Sheet>
  );
}

type Tab = "open" | "fixed" | "resolved";

function ThreadRows({ list, onOpen }: { list: Thread[]; onOpen(thread: Thread): void }) {
  if (list.length === 0) return <div class="empty">Nothing here.</div>;
  return (
    <div class="group">
      {list.map((thread) => (
        <button type="button" class="thread-row" key={thread.id} onClick={() => onOpen(thread)}>
          <span class={`pin static${thread.status === "resolved" ? " done" : ""}`}>{thread.n}</span>
          <span class="grow">
            <span class="ss">{thread.author.name}</span>
            <span class="body">{thread.comments[0]?.body}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function Tabs({ tab, threads }: { tab: { value: Tab }; threads: Thread[] }) {
  return (
    <div class="seg">
      {(["open", "fixed", "resolved"] as const).map((value) => (
        <button
          type="button"
          key={value}
          aria-pressed={tab.value === value}
          onClick={() => {
            tab.value = value;
          }}
        >
          {value[0]?.toUpperCase()}
          {value.slice(1)} {threads.filter((thread) => thread.status === value).length}
        </button>
      ))}
    </div>
  );
}

export function CommentsSheet({
  threads,
  onOpen,
  onClose,
}: {
  threads: Thread[];
  onOpen(thread: Thread): void;
  onClose(): void;
}) {
  const tab = useSignal<Tab>("open");
  return (
    <Sheet title="Comments" onClose={onClose}>
      <Tabs tab={tab} threads={threads} />
      <ThreadRows list={threads.filter((thread) => thread.status === tab.value)} onOpen={onOpen} />
    </Sheet>
  );
}

/** The right panel on wide screens (board 04). */
export function CommentsPanel({ threads, onOpen }: { threads: Thread[]; onOpen(thread: Thread): void }) {
  const tab = useSignal<Tab>("open");
  return (
    <aside class="panel" aria-label="Comments">
      <Tabs tab={tab} threads={threads} />
      <ThreadRows list={threads.filter((thread) => thread.status === tab.value)} onOpen={onOpen} />
    </aside>
  );
}

/** Approve or Request changes (05·3). Nothing is pushed to the agent; it reads this next time it runs. */
export function DecideSheet({
  artifact,
  onClose,
  onDone,
}: {
  artifact: Artifact;
  onClose(): void;
  onDone(): void;
}) {
  const kind = useSignal<"approved" | "changes_requested">("approved");
  const note = useSignal("");
  const error = useSignal<string | null>(null);
  async function submit() {
    try {
      await post(`/api/artifacts/${artifact.id}/decisions`, {
        version: artifact.latestVersion,
        kind: kind.value,
        note: note.value || null,
      });
      onDone();
    } catch (failure) {
      error.value = message(failure);
    }
  }
  return (
    <Sheet title={`Decide on v${artifact.latestVersion}`} onClose={onClose}>
      <div class="seg">
        <button
          type="button"
          aria-pressed={kind.value === "approved"}
          onClick={() => {
            kind.value = "approved";
          }}
        >
          Approve
        </button>
        <button
          type="button"
          aria-pressed={kind.value === "changes_requested"}
          onClick={() => {
            kind.value = "changes_requested";
          }}
        >
          Request changes
        </button>
      </div>
      <label class="gh" for="decision-note">
        Note
      </label>
      <textarea
        id="decision-note"
        class="field"
        rows={3}
        value={note.value}
        onInput={(e) => {
          note.value = e.currentTarget.value;
        }}
      />
      {artifact.counts.open > 0 && <p class="fn">{artifact.counts.open} open comments go with it.</p>}
      {error.value && <p class="err">{error.value}</p>}
      <button type="button" class="btn ink" onClick={submit}>
        {kind.value === "approved" ? "Approve" : "Request changes"}
      </button>
      <p class="fn center">
        {agentShort(artifact.agent ?? "The agent")} sees this the next time it runs{" "}
        <span class="mono">artifacts status</span>.
      </p>
    </Sheet>
  );
}

export const reloadThreads = (id: string) => api<Thread[]>(`/api/artifacts/${id}/threads`);
