import type { Anchor, Artifact, Comment, Thread } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { Check, Copy, X } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import { ApiFailure, api, post } from "../api.ts";
import { agentInitials, agentPrompt, agentShort, ago } from "../format.ts";
import { askInstall, shouldAsk } from "../notify.ts";
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
      if (me.value && shouldAsk()) askInstall.value = true;
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
  useKeyboardInset();
  const reply = useSignal("");
  const error = useSignal<string | null>(null);
  const canAct = artifact.permissions.comment;
  // Resolving and reopening are decisions: people only, and not on access a token granted (04).
  const canDecide = canAct && artifact.permissions.decide !== false;

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
            canDecide && (
              <button
                type="button"
                class="btn soft fit"
                onClick={() => run(() => post(`/api/threads/${thread.id}/reopen`))}
              >
                Reopen
              </button>
            )
          ) : (
            me.value &&
            canDecide && (
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

/** Nothing reaches an agent by itself, so this copies what a person pastes into theirs. */
function CopyPrompt({ artifact, ink }: { artifact: Artifact; ink?: boolean }) {
  const state = useSignal<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const prompt = agentPrompt(artifact, location.origin);
  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(prompt);
      state.value = "copied";
      timer.current = setTimeout(() => {
        state.value = "idle";
      }, 2600);
    } catch {
      state.value = "failed";
    }
  }
  return (
    <>
      <button
        type="button"
        class={`btn ${ink ? "ink" : "soft"} copy-prompt${state.value === "copied" ? " done" : ""}`}
        aria-live="polite"
        onClick={copy}
      >
        {state.value === "copied" ? <Check /> : <Copy />}
        {state.value === "copied" ? "Copied. Paste it to your agent" : "Copy prompt for your agent"}
      </button>
      {state.value === "failed" && (
        <>
          <p class="fn">Couldn't copy. Press and hold to select this.</p>
          <pre class="term copy-prompt-text">{prompt}</pre>
        </>
      )}
    </>
  );
}

/** Shown to the people who can decide. Guests have no agent to paste into. */
function OpenPrompt({ artifact, tab, threads }: { artifact: Artifact; tab: Tab; threads: Thread[] }) {
  const open = threads.some((thread) => thread.status === "open");
  const canDecide = artifact.permissions.comment && artifact.permissions.decide !== false && me.value;
  return tab === "open" && open && canDecide ? <CopyPrompt artifact={artifact} /> : null;
}

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
  artifact,
  threads,
  onOpen,
  onClose,
}: {
  artifact: Artifact;
  threads: Thread[];
  onOpen(thread: Thread): void;
  onClose(): void;
}) {
  const tab = useSignal<Tab>("open");
  return (
    <Sheet title="Comments" onClose={onClose}>
      <Tabs tab={tab} threads={threads} />
      <ThreadRows list={threads.filter((thread) => thread.status === tab.value)} onOpen={onOpen} />
      <OpenPrompt artifact={artifact} tab={tab.value} threads={threads} />
    </Sheet>
  );
}

/** The right panel on wide screens (board 04). */
export function CommentsPanel({
  artifact,
  threads,
  onOpen,
}: {
  artifact: Artifact;
  threads: Thread[];
  onOpen(thread: Thread): void;
}) {
  const tab = useSignal<Tab>("open");
  return (
    <aside class="panel" aria-label="Comments">
      <Tabs tab={tab} threads={threads} />
      <ThreadRows list={threads.filter((thread) => thread.status === tab.value)} onOpen={onOpen} />
      <OpenPrompt artifact={artifact} tab={tab.value} threads={threads} />
    </aside>
  );
}

/**
 * Approve or Request changes (05·3). Nothing is pushed to the agent; it reads this next time it runs,
 * so Request changes stays open to offer the prompt that starts that run.
 */
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
  const requested = useSignal(false);
  async function submit() {
    try {
      await post(`/api/artifacts/${artifact.id}/decisions`, {
        version: artifact.latestVersion,
        kind: kind.value,
        note: note.value || null,
      });
      onDone();
      if (kind.value === "approved") onClose();
      else requested.value = true;
    } catch (failure) {
      error.value = message(failure);
    }
  }
  if (requested.value) {
    return (
      <Sheet title="Changes requested" onClose={onClose}>
        <p class="copy-prompt-note">
          Your agent won't see this until you tell it. Paste this prompt where it's working.
        </p>
        <CopyPrompt artifact={artifact} ink />
      </Sheet>
    );
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
