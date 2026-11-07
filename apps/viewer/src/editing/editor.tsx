import "./editor.css";
import type {
  Artifact,
  Attribution,
  CheckpointResult,
  DocState,
  EditMode,
  Run,
  Suggestion,
  SyncControl,
} from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { ChevronDown, Ellipsis, Keyboard, Link2, List, Pencil, Redo2, Square, Undo2 } from "lucide-preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { baseKeymap, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { type Command, EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { redo, undo, yCursorPlugin, ySyncPlugin, yUndoPlugin } from "y-prosemirror";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { api, message, post } from "../api.ts";
import { Avatar } from "../components/cards.tsx";
import { Sheet } from "../components/sheet.tsx";
import { agentShort, plural } from "../format.ts";
import { compareHref } from "../paths.ts";
import { me } from "../session.ts";
import { AuthorPopover, type Picked, type SourceInfo } from "../wiki/attribution.tsx";
import { blockIdPlugin, editorSchema } from "./doc.ts";
import {
  authorPlugin,
  blockAt,
  caret,
  diffWords,
  pencilPlugin,
  presencePlugin,
  redrawPencil,
  safeHref,
  safeLinksPlugin,
  setSuggestions,
  suggestionAtCaret,
  suggestionLabel,
  suggestionsPlugin,
  textOf,
} from "./plugins.ts";
import { connect, type Hello, type Provider, type Status } from "./sync.ts";

export type EditorProps = {
  artifact: Artifact;
  pageKey: string;
  state: DocState;
  sources(slug: string): SourceInfo | null;
  onClose(): void;
};

const MODES: { mode: EditMode; word: string; says: (agent: string) => string }[] = [
  { mode: "write", word: "Write", says: (agent) => `You type. ${agent} stays out.` },
  {
    mode: "pair",
    word: "Pair",
    says: (agent) => `${agent} suggests beside you, inline. You accept or reject.`,
  },
  {
    mode: "delegate",
    word: "Delegate",
    says: () => "Say what you want and leave. Review a checkpoint after.",
  },
];
const AGENT = "Claude";
const storedKey = (artifactId: string) => `artifacts.edit.${artifactId}.author`;
const announce = (live: HTMLElement | null, text: string) => {
  if (live) live.textContent = text;
};

/** How agents' edits land here, in a line: what the audience means before a mode is picked (13, "Policy"). */
function audienceLine(state: DocState) {
  if (state.agentMaintained) return "Maintained by agents: their edits apply directly";
  if (!state.audience) return null;
  const lands = state.agents?.edits === "direct" ? "apply directly" : "arrive as suggestions";
  return `${state.audience.label} · ${AGENT}'s edits ${lands}`;
}

export function Editor({ artifact, pageKey, state: initial, sources, onClose }: EditorProps) {
  const mount = useRef<HTMLDivElement>(null);
  const live = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const provider = useRef<Provider | null>(null);
  const awareness = useRef<Awareness | null>(null);
  const doc = useSignal<DocState>(initial);
  const mode = useSignal<EditMode>("write");
  const status = useSignal<Status>("connecting");
  const hello = useSignal<Hello | null>(null);
  // Read-only until the server's copy has arrived: typing into the empty local document first would
  // leave a stray paragraph beside the page, and text with no author key the server refuses.
  const ready = useSignal(false);
  const readyRef = useRef(false);
  const others = useSignal<{ name: string; kind: string; for?: string | null }[]>([]);
  const suggestions = useSignal<Suggestion[]>([]);
  const authors = useSignal<Attribution["authors"]>([]);
  const sheet = useSignal<null | "modes" | "save" | "delegate" | "menu" | "review" | "link">(null);
  const keyboard = useSignal(0);
  const notice = useSignal<string | null>(null);
  const error = useSignal<string | null>(null);
  const picked = useSignal<Picked | null>(null);
  const reset = useSignal(false);
  const marks = useSignal({ strong: false, em: false, list: false, heading: false });
  const agentKeys = useRef(new Set<string>());
  const authorRef = useRef<string | null>(null);

  const base = `/api/artifacts/${artifact.id}`;
  const refreshDoc = () =>
    api<DocState>(`${base}/doc`).then(
      (value) => {
        doc.value = value;
      },
      () => {},
    );
  const refreshSuggestions = () =>
    api<{ suggestions: Suggestion[] }>(`${base}/suggestions?status=open`).then(
      (value) => {
        const before = new Set(suggestions.value.map((s) => s.id));
        suggestions.value = value.suggestions;
        const fresh = value.suggestions.filter((s) => !before.has(s.id));
        if (fresh[0])
          announce(live.current, `${suggestionLabel(fresh[0].author)} a change to ${artifact.title}`);
        if (view.current) setSuggestions(view.current, value.suggestions);
      },
      () => {},
    );
  const refreshAuthors = () =>
    api<Attribution>(`${base}/authors?draft=1`).then(
      (value) => {
        authors.value = value.authors;
        agentKeys.current = new Set(value.authors.filter((a) => a.kind === "agent").map((a) => a.key));
        if (view.current) redrawPencil(view.current);
      },
      () => {},
    );

  const decide = (id: string, verb: "accept" | "reject") =>
    post(`/api/suggestions/${id}/${verb}`, {}).then(
      () => {
        suggestions.value = suggestions.value.filter((s) => s.id !== id);
        if (view.current) setSuggestions(view.current, suggestions.value);
        notice.value = verb === "accept" ? "Accepted" : "Rejected";
        refreshAuthors();
      },
      (failure) => {
        error.value = message(failure);
        refreshSuggestions();
      },
    );

  // The document, its sync and its plugins: made once per open editor.
  useLayoutEffect(() => {
    const ydoc = new Y.Doc();
    const people = new Awareness(ydoc);
    awareness.current = people;
    authorRef.current = localStorage.getItem(storedKey(artifact.id));
    const self = me.value;
    people.setLocalState({
      user: { author: authorRef.current ?? "", name: self?.name ?? "You", kind: "person", color: "#ffd84d" },
      mode: mode.value,
      block: null,
      pending: [],
    });
    const fragment = ydoc.getXmlFragment("doc");
    const commands = editorCommands({
      save: () => {
        sheet.value = "save";
      },
      leave: onClose,
      link: () => {
        sheet.value = "link";
      },
      decide: (verb) => {
        const at = view.current && suggestionAtCaret(view.current.state);
        if (at) decide(at.id, verb);
        return !!at;
      },
    });
    const editor = new EditorView(mount.current, {
      state: EditorState.create({
        schema: editorSchema,
        plugins: [
          ySyncPlugin(fragment),
          yCursorPlugin(people, { cursorBuilder: caret }),
          yUndoPlugin(),
          keymap(commands),
          keymap(baseKeymap),
          blockIdPlugin(),
          safeLinksPlugin(),
          authorPlugin(() => authorRef.current),
          presencePlugin((block, pending) => {
            people.setLocalStateField("block", block);
            people.setLocalStateField("pending", pending);
          }),
          pencilPlugin(() => agentKeys.current),
          suggestionsPlugin({ accept: (id) => decide(id, "accept"), reject: (id) => decide(id, "reject") }),
        ],
      }),
      editable: () => readyRef.current,
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": `Edit ${artifact.title}`,
        class: "article-body ed-body",
        autocapitalize: "sentences",
        spellcheck: "true",
      },
      // Called with the view as `this`, during construction too, before `editor` is assigned.
      dispatchTransaction(this: EditorView, tr) {
        // After Done or Esc, nothing may reach the closed view. y-prosemirror (1.3.7) flushes metas it
        // queued for cursors and awareness on a timeout, and its "destroyed" check reads a field its
        // binding never sets, so the guard is here.
        if (this.isDestroyed) return;
        const next = this.state.apply(tr);
        this.updateState(next);
        const { $from } = next.selection;
        const has = (name: "strong" | "em") => {
          const type = editorSchema.marks[name];
          return !!type && !!(next.storedMarks ?? $from.marks()).some((m) => m.type === type);
        };
        marks.value = {
          strong: has("strong"),
          em: has("em"),
          list: $from.depth > 1 && /list/.test($from.node(1).type.name),
          heading: $from.parent.type.name === "heading",
        };
      },
      handleClickOn(_view, _pos, _node, _nodePos, event) {
        const pen = (event.target as HTMLElement).closest?.<HTMLElement>("span.pen[data-author]");
        const author = pen && authors.value.find((a) => a.key === pen.dataset.author);
        if (!pen || !author) return false;
        picked.value = { author, time: "", rect: pen.getBoundingClientRect() };
        return false;
      },
      handlePaste(_view, event) {
        if (event.clipboardData && [...event.clipboardData.items].some((item) => item.kind === "file")) {
          error.value = "Add images with the CLI for now.";
          return true;
        }
        return false;
      },
    });
    view.current = editor;

    const sync = connect(artifact.id, initial.epoch, ydoc, people);
    provider.current = sync;
    const off = [
      sync.on("status", (value) => {
        status.value = value;
      }),
      sync.on("hello", (value) => {
        hello.value = value;
        authorRef.current = value.author;
        localStorage.setItem(storedKey(artifact.id), value.author);
        sync.send({ t: "mode", mode: mode.value });
      }),
      sync.on("synced", () => {
        if (readyRef.current) return;
        readyRef.current = true;
        ready.value = true;
        editor.setProps({});
        editor.focus();
      }),
      sync.on("control", (control: SyncControl) => {
        if (control.t === "suggestion") refreshSuggestions();
        else if (control.t === "run") {
          refreshDoc();
          refreshSuggestions();
        } else if (control.t === "checkpoint") {
          refreshDoc();
          notice.value = `Saved v${control.version}`;
        } else if (control.t === "reset") reset.value = true;
        else if (control.t === "error") error.value = control.message;
      }),
    ];
    const onPeople = () => {
      const list: { name: string; kind: string; for?: string | null }[] = [];
      people.getStates().forEach((value, client) => {
        if (client === ydoc.clientID || !value.user) return;
        list.push(value.user);
      });
      others.value = list;
    };
    people.on("change", onPeople);
    return () => {
      // The view goes first: awareness and sync emit as they close, and a closed view can't take that.
      view.current = null;
      for (const stop of off) stop();
      people.off("change", onPeople);
      editor.destroy();
      sync.destroy();
      people.destroy();
      ydoc.destroy();
    };
  }, [artifact.id]);

  useEffect(() => {
    refreshSuggestions();
    refreshAuthors();
    const timer = setInterval(refreshDoc, 15_000);
    return () => clearInterval(timer);
  }, [artifact.id]);

  // The toolbar rides the keyboard: visualViewport says how much of the layout viewport it covers.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const onResize = () => {
      const covered = Math.max(0, innerHeight - viewport.height - viewport.offsetTop);
      keyboard.value = covered > 80 ? covered : 0;
    };
    viewport.addEventListener("resize", onResize);
    viewport.addEventListener("scroll", onResize);
    onResize();
    return () => {
      viewport.removeEventListener("resize", onResize);
      viewport.removeEventListener("scroll", onResize);
    };
  }, []);

  // The editor takes the screen; the reader under it doesn't scroll along.
  useEffect(() => {
    document.documentElement.classList.add("editing");
    return () => document.documentElement.classList.remove("editing");
  }, []);

  useEffect(() => {
    if (!notice.value) return;
    const timer = setTimeout(() => {
      notice.value = null;
    }, 2600);
    return () => clearTimeout(timer);
  }, [notice.value]);

  const pick = (next: EditMode) => {
    mode.value = next;
    awareness.current?.setLocalStateField("mode", next);
    provider.current?.send({ t: "mode", mode: next });
    sheet.value = next === "delegate" && !activeRun ? "delegate" : null;
    if (next === "pair") refreshSuggestions();
  };
  const run = (command: Command) => {
    const editor = view.current;
    if (!editor) return;
    command(editor.state, editor.dispatch, editor);
    editor.focus();
  };

  const state = doc.value;
  const runs = state.runs ?? [];
  const activeRun = runs.find((r) => r.status === "active") ?? null;
  const finished = runs.find((r) => r.status === "finished") ?? null;
  const line = audienceLine(state);
  const typing = keyboard.value > 0;
  const saved = !ready.value
    ? status.value === "offline"
      ? "Offline"
      : "Connecting"
    : status.value === "offline"
      ? "Offline. Your changes will sync."
      : status.value === "online"
        ? "Saved"
        : "";
  const modeWord = MODES.find((m) => m.mode === mode.value)?.word ?? "Write";

  const modes = (
    <div class="ed-modes">
      {MODES.map((entry) => (
        <button
          type="button"
          aria-pressed={mode.value === entry.mode}
          class={mode.value === entry.mode ? "on" : ""}
          key={entry.mode}
          onClick={() => pick(entry.mode)}
        >
          {entry.word}
        </button>
      ))}
    </div>
  );
  const who = (
    <ul class="who ed-who" aria-label="Who is here">
      <li>
        <Avatar name={me.value?.name ?? "You"} you />
        <span class="sr">You</span>
      </li>
      {others.value.map((user, index) => (
        <li key={`${user.name}-${index}`}>
          {user.kind === "agent" ? (
            <span class="av agent">
              <Pencil />
            </span>
          ) : (
            <Avatar name={user.name} />
          )}
          <span class="sr">
            {user.kind === "agent" && user.for ? `${user.name} for ${user.for}` : user.name}
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <div class={`ed${typing ? " typing" : ""}`} style={{ "--kb": `${keyboard.value}px` }}>
      <header class="ed-bar">
        <button type="button" class="txtbtn" onClick={onClose}>
          Done
        </button>
        <span class="ed-title tag">{artifact.title}</span>
        <div class="ed-modes-wide">{modes}</div>
        <span class="grow" />
        {who}
        <span class="saved" role="status">
          {saved}
        </span>
        <button
          type="button"
          class="btn soft fit ed-save-wide"
          onClick={() => {
            sheet.value = "save";
          }}
        >
          Save version
        </button>
        <button
          type="button"
          class="round"
          aria-label="More"
          onClick={() => {
            sheet.value = "menu";
          }}
        >
          <Ellipsis />
        </button>
      </header>
      {!typing && (
        <div class="ed-modes-row">
          {modes}
          {state.audience && <span class="aud">{state.audience.label}</span>}
        </div>
      )}
      {activeRun && (
        <div class="lockline" role="status">
          <Pencil />
          {agentShort(activeRun.agent ?? AGENT)} has the pen. Typing takes it back.
        </div>
      )}
      <div
        class="ed-tools"
        role="toolbar"
        aria-label="Formatting"
        aria-orientation="horizontal"
        onKeyDown={roving}
      >
        {typing && (
          <button
            type="button"
            class="k mode"
            aria-label={`Mode: ${modeWord}`}
            onMouseDown={keep}
            onClick={() => {
              sheet.value = "modes";
            }}
          >
            {modeWord}
            <ChevronDown />
          </button>
        )}
        <button
          type="button"
          class={`k serif${marks.value.heading ? " on" : ""}`}
          aria-label="Heading"
          aria-pressed={marks.value.heading}
          onMouseDown={keep}
          onClick={() => run(toggleHeading)}
        >
          Aa
        </button>
        <i class="vs" />
        <button
          type="button"
          class={`k${marks.value.strong ? " on" : ""}`}
          aria-label="Bold"
          aria-pressed={marks.value.strong}
          onMouseDown={keep}
          onClick={() => run(toggleMark(editorSchema.marks.strong as never))}
        >
          B
        </button>
        <button
          type="button"
          class={`k serif${marks.value.em ? " on" : ""}`}
          aria-label="Italic"
          aria-pressed={marks.value.em}
          onMouseDown={keep}
          onClick={() => run(toggleMark(editorSchema.marks.em as never))}
        >
          <i>I</i>
        </button>
        <button
          type="button"
          class={`k${marks.value.list ? " on" : ""}`}
          aria-label="List"
          aria-pressed={marks.value.list}
          onMouseDown={keep}
          onClick={() => run(toggleList)}
        >
          <List />
        </button>
        <i class="vs" />
        <button
          type="button"
          class="k"
          aria-label="Link a page"
          onMouseDown={keep}
          onClick={() => run(insertText("[["))}
        >
          [[
        </button>
        <button
          type="button"
          class="k"
          aria-label="Link"
          onMouseDown={keep}
          onClick={() => {
            sheet.value = "link";
          }}
        >
          <Link2 />
        </button>
        <span class="grow" />
        {line && <span class="tag ed-aud-wide">{line}</span>}
        <button type="button" class="k" aria-label="Undo" onMouseDown={keep} onClick={() => run(undo)}>
          <Undo2 />
        </button>
        <button
          type="button"
          class="k ed-redo"
          aria-label="Redo"
          onMouseDown={keep}
          onClick={() => run(redo)}
        >
          <Redo2 />
        </button>
        {typing && (
          <button
            type="button"
            class="k"
            aria-label="Hide keyboard"
            onClick={() => (document.activeElement as HTMLElement | null)?.blur()}
          >
            <Keyboard />
          </button>
        )}
      </div>
      <main class="ed-page">
        <article class="article ed-article">
          <div class="meta">
            <span>v{state.version}</span>
            {state.dirty && <span>Draft</span>}
            {state.openSuggestions > 0 && (
              <span class="word agent">{plural(state.openSuggestions, "suggestion")}</span>
            )}
          </div>
          {!ready.value && (
            <p class="ed-wait" role="status">
              {status.value === "offline"
                ? "Offline. The page opens for editing as soon as it connects."
                : "Connecting to the page…"}
            </p>
          )}
          <div ref={mount} class={`ed-mount${ready.value ? "" : " waiting"}`} />
        </article>
      </main>
      {(activeRun || finished) && (
        <RunStrip
          run={(activeRun ?? finished) as Run}
          artifact={artifact}
          onStop={() =>
            post(`/api/runs/${activeRun?.id}/cancel`, {}).then(refreshDoc, (f) => {
              error.value = message(f);
            })
          }
          onReview={() => {
            sheet.value = "review";
          }}
        />
      )}
      <div ref={live} class="sr" aria-live="polite" />
      {notice.value && (
        <div class="toast" role="status">
          {notice.value}
        </div>
      )}
      {error.value && (
        <div class="toast err-toast" role="alert">
          {error.value}
          <button
            type="button"
            class="txtbtn"
            onClick={() => {
              error.value = null;
            }}
          >
            OK
          </button>
        </div>
      )}
      {sheet.value === "modes" && (
        <Sheet title={`How should ${AGENT} help?`} onClose={() => (sheet.value = null)}>
          <div class="group">
            {MODES.map((entry) => (
              <button
                type="button"
                aria-pressed={mode.value === entry.mode}
                class="li btn-li"
                key={entry.mode}
                onClick={() => pick(entry.mode)}
              >
                <div class="grow">
                  <div class="tt">{entry.word}</div>
                  <div class="ss">{entry.says(AGENT)}</div>
                </div>
                {mode.value === entry.mode && <span class="ck">✓</span>}
              </button>
            ))}
          </div>
          {line && <p class="fn">{line}.</p>}
        </Sheet>
      )}
      {sheet.value === "save" && (
        <SaveSheet
          base={base}
          version={state.version}
          onClose={() => (sheet.value = null)}
          onSaved={(result) => {
            sheet.value = null;
            notice.value = result.created ? `Saved v${result.version}` : "Nothing new to save";
            refreshDoc();
          }}
        />
      )}
      {sheet.value === "delegate" && (
        <DelegateSheet
          base={base}
          onClose={() => (sheet.value = null)}
          onStarted={() => {
            sheet.value = null;
            refreshDoc();
          }}
        />
      )}
      {sheet.value === "review" && finished && (
        <ReviewSheet
          run={finished}
          artifact={artifact}
          list={suggestions.value.filter((s) => s.run === finished.id)}
          blockText={(id) => {
            const editor = view.current;
            let text = "";
            editor?.state.doc.forEach((node) => {
              if (node.attrs.id === id) text = node.textContent;
            });
            return text;
          }}
          onClose={() => (sheet.value = null)}
          onDone={(text) => {
            sheet.value = null;
            notice.value = text;
            refreshDoc();
            refreshSuggestions();
            refreshAuthors();
          }}
          onRevert={(id) => decide(id, "reject")}
        />
      )}
      {sheet.value === "link" && (
        <LinkSheet
          onClose={() => (sheet.value = null)}
          onLink={(href) => {
            sheet.value = null;
            const type = editorSchema.marks.link;
            if (type) run(toggleMark(type, { href }));
          }}
        />
      )}
      {sheet.value === "menu" && (
        <Sheet title={artifact.title} onClose={() => (sheet.value = null)}>
          <div class="group">
            <button type="button" class="li btn-li" onClick={() => (sheet.value = "save")}>
              <div class="grow">
                <div class="tt">Save version</div>
                <div class="ss">Readers see v{state.version} until you do.</div>
              </div>
            </button>
            <button
              type="button"
              class="li btn-li"
              onClick={() => (sheet.value = mode.value === "delegate" ? "delegate" : "modes")}
            >
              <div class="grow">
                <div class="tt">Let an agent work on this</div>
                <div class="ss">Delegate, then review its checkpoint.</div>
              </div>
            </button>
            {state.canMaintain && (
              <button
                type="button"
                class="li btn-li"
                onClick={() =>
                  api<DocState>(`${base}/doc/maintained`, {
                    method: "PUT",
                    json: { agentMaintained: !state.agentMaintained },
                  }).then(
                    (value) => {
                      doc.value = value;
                      sheet.value = null;
                    },
                    (f) => {
                      error.value = message(f);
                    },
                  )
                }
              >
                <div class="grow">
                  <div class="tt">
                    {state.agentMaintained ? "Stop agent upkeep" : "Mark as agent-maintained"}
                  </div>
                  <div class="ss">Agents' edits on this page apply directly, with a checkpoint.</div>
                </div>
              </button>
            )}
          </div>
        </Sheet>
      )}
      {reset.value && (
        <Sheet title="This page was published again" onClose={onClose}>
          <p class="ss">
            Someone published a new version from the CLI, so the draft started again from it. Changes made
            offline couldn't be merged.
          </p>
          <button type="button" class="btn ink" onClick={onClose}>
            Read the new version
          </button>
        </Sheet>
      )}
      {picked.value && (
        <AuthorPopover
          picked={picked.value}
          version={null}
          sources={sources}
          onClose={() => (picked.value = null)}
        />
      )}
      <span hidden>{pageKey}</span>
    </div>
  );
}

/** Pressing a toolbar key mustn't take the caret out of the page on a desktop. */
const keep = (event: MouseEvent) => event.preventDefault();

/** Arrow keys move along the toolbar (roving focus), as a toolbar should. */
function roving(event: KeyboardEvent) {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
  const keys = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button")];
  const at = keys.indexOf(document.activeElement as HTMLButtonElement);
  const next = keys[(at + (event.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length];
  next?.focus();
  event.preventDefault();
}

const insertText =
  (text: string): Command =>
  (state, dispatch) => {
    dispatch?.(state.tr.insertText(text));
    return true;
  };

const toggleHeading: Command = (state, dispatch, view) => {
  const { heading, paragraph } = editorSchema.nodes;
  if (!heading || !paragraph) return false;
  return state.selection.$from.parent.type === heading
    ? setBlockType(paragraph)(state, dispatch, view)
    : setBlockType(heading, { level: 2 })(state, dispatch, view);
};

const toggleList: Command = (state, dispatch, view) => {
  const { bullet_list, list_item } = editorSchema.nodes;
  if (!bullet_list || !list_item) return false;
  return liftListItem(list_item)(state, dispatch, view) || wrapInList(bullet_list)(state, dispatch, view);
};

/** Moves the caret's top-level block up or down, keeping its id (13, "Editing behaviour"). */
const moveBlock =
  (direction: -1 | 1): Command =>
  (state, dispatch) => {
    const here = blockAt(state.doc, state.selection.head);
    if (!here) return false;
    const index = state.doc.resolve(here.from + 1).index(0);
    const other = index + direction;
    if (other < 0 || other >= state.doc.childCount) return false;
    const node = here.node;
    const neighbour = state.doc.child(other);
    const tr = state.tr.delete(here.from, here.from + node.nodeSize);
    const to = direction < 0 ? here.from - neighbour.nodeSize : here.from + neighbour.nodeSize;
    tr.insert(to, node);
    const offset = state.selection.head - here.from;
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(to + offset, tr.doc.content.size))));
    dispatch?.(tr.scrollIntoView());
    return true;
  };

function editorCommands({
  save,
  leave,
  link,
  decide,
}: {
  save(): void;
  leave(): void;
  link(): void;
  decide(verb: "accept" | "reject"): boolean;
}): Record<string, Command> {
  const { strong, em } = editorSchema.marks;
  const item = editorSchema.nodes.list_item;
  const quote = editorSchema.nodes.blockquote;
  return {
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
    "Mod-b": strong ? toggleMark(strong) : () => false,
    "Mod-i": em ? toggleMark(em) : () => false,
    "Mod-k": () => {
      link();
      return true;
    },
    "Mod-s": () => {
      save();
      return true;
    },
    "Alt-ArrowUp": moveBlock(-1),
    "Alt-ArrowDown": moveBlock(1),
    "Mod-Alt-y": () => decide("accept"),
    "Mod-Alt-n": () => decide("reject"),
    "Mod-Shift-.": quote ? wrapIn(quote) : () => false,
    Escape: () => {
      leave();
      return true;
    },
    ...(item ? { Enter: splitListItem(item), Tab: sinkListItem(item), "Shift-Tab": liftListItem(item) } : {}),
  };
}

function RunStrip({
  run,
  artifact,
  onStop,
  onReview,
}: {
  run: Run;
  artifact: Artifact;
  onStop(): void;
  onReview(): void;
}) {
  const agent = agentShort(run.agent ?? AGENT);
  return (
    <div class="strip" role="status">
      <div class="rowx">
        <span class="av agent">
          <Pencil />
        </span>
        <div class="grow">
          <div class="tt agent-word">
            {run.status === "active" ? `${agent} is working on this page` : `${agent} finished`}
          </div>
          <div class="ss">
            {run.goal}
            {run.status !== "active" && run.edits === "suggestion"
              ? ` · ${plural(run.suggestions, "change")}`
              : ""}
          </div>
        </div>
      </div>
      <div class="acts">
        {run.status === "active" ? (
          <button type="button" class="btn soft" onClick={onStop}>
            <Square />
            Stop
          </button>
        ) : run.edits === "suggestion" ? (
          <button type="button" class="btn mark" onClick={onReview}>
            Review the changes
          </button>
        ) : run.version ? (
          <a class="btn mark" href={compareHref(artifact, run.version - 1, run.version)}>
            Review v{run.version}
          </a>
        ) : null}
      </div>
    </div>
  );
}

function SaveSheet({
  base,
  version,
  onClose,
  onSaved,
}: {
  base: string;
  version: number;
  onClose(): void;
  onSaved(result: CheckpointResult): void;
}) {
  const name = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  return (
    <Sheet title="Save a version" onClose={onClose}>
      <p class="ss">Readers see this one. Comments and compare work on it.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          busy.value = true;
          post<CheckpointResult>(`${base}/doc/checkpoint`, { name: name.value.trim() || null }).then(
            onSaved,
            (f) => {
              busy.value = false;
              error.value = message(f);
            },
          );
        }}
      >
        <input
          class="field"
          aria-label="Name this version"
          placeholder="Name it (optional)"
          value={name.value}
          maxLength={80}
          onInput={(event) => {
            name.value = event.currentTarget.value;
          }}
        />
        {error.value && <p class="err">{error.value}</p>}
        <button type="submit" class="btn mark" disabled={busy.value}>
          Save v{version + 1}
        </button>
      </form>
    </Sheet>
  );
}

function DelegateSheet({
  base,
  onClose,
  onStarted,
}: {
  base: string;
  onClose(): void;
  onStarted(run: Run): void;
}) {
  const goal = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  return (
    <Sheet title={`What should ${AGENT} do?`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!goal.value.trim()) return;
          busy.value = true;
          post<Run>(`${base}/doc/runs`, { goal: goal.value.trim() }).then(onStarted, (f) => {
            busy.value = false;
            error.value = message(f);
          });
        }}
      >
        <textarea
          class="field tall"
          aria-label="What should the agent do"
          placeholder="Fold the Q3 board notes into Plans, and cite them."
          rows={3}
          maxLength={500}
          value={goal.value}
          onInput={(event) => {
            goal.value = event.currentTarget.value;
          }}
        />
        <p class="fn">
          An agent connected to Artifacts picks this up and works on a draft. Nothing reaches readers until
          you keep its checkpoint.
        </p>
        {error.value && <p class="err">{error.value}</p>}
        <button type="submit" class="btn mark" disabled={busy.value || !goal.value.trim()}>
          Start
        </button>
      </form>
    </Sheet>
  );
}

/** A finished run's change set: each change with its sources, Revert one, Revert all, or Keep. */
function ReviewSheet({
  run,
  artifact,
  list,
  blockText,
  onClose,
  onDone,
  onRevert,
}: {
  run: Run;
  artifact: Artifact;
  list: Suggestion[];
  blockText(id: string): string;
  onClose(): void;
  onDone(text: string): void;
  onRevert(id: string): void;
}) {
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const agent = agentShort(run.agent ?? AGENT);
  const end = (verb: "accept" | "reject") => {
    busy.value = true;
    post<Run>(`/api/runs/${run.id}/${verb}`, {}).then(
      (after) =>
        onDone(verb === "accept" ? `Kept${after.version ? ` as v${after.version}` : ""}` : "Reverted"),
      (f) => {
        busy.value = false;
        error.value = message(f);
      },
    );
  };
  return (
    <Sheet title="What changed" subtitle={`${agent} · ${plural(list.length, "change")}`} onClose={onClose}>
      <p class="ss">“{run.goal}”</p>
      <div class="group review-list">
        {list.map((suggestion) => (
          <div class="li review-change" key={suggestion.id}>
            <div class="grow">
              <DiffText
                before={suggestion.op === "insert" || !suggestion.block ? "" : blockText(suggestion.block)}
                after={
                  suggestion.op === "delete" ? "" : textOf(suggestion.html) || (suggestion.markdown ?? "")
                }
              />
              {suggestion.sources.length > 0 && <div class="ss">From {suggestion.sources.join(", ")}</div>}
            </div>
            <button
              type="button"
              class="round"
              aria-label="Revert this change"
              onClick={() => onRevert(suggestion.id)}
            >
              <Undo2 />
            </button>
          </div>
        ))}
        {list.length === 0 && <p class="ss li">No changes are left to review.</p>}
      </div>
      {error.value && <p class="err">{error.value}</p>}
      <div class="acts">
        <button type="button" class="btn soft" disabled={busy.value} onClick={() => end("reject")}>
          Revert all
        </button>
        <button type="button" class="btn mark" disabled={busy.value} onClick={() => end("accept")}>
          Keep
        </button>
      </div>
      <span hidden>{artifact.id}</span>
    </Sheet>
  );
}

function DiffText({ before, after }: { before: string; after: string }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    box.current?.replaceChildren(diffWords(before, after));
  }, [before, after]);
  return <div ref={box} class="review-diff" />;
}

function LinkSheet({ onClose, onLink }: { onClose(): void; onLink(href: string): void }) {
  const href = useSignal("https://");
  const refused = useSignal(false);
  const field = useRef<HTMLInputElement>(null);
  // The address takes focus as the sheet opens (after the sheet's own focus), caret after "https://".
  useLayoutEffect(() => {
    const input = field.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }, []);
  return (
    <Sheet title="Link" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const value = href.value.trim();
          if (safeHref(value)) onLink(value);
          else refused.value = true;
        }}
      >
        <input
          ref={field}
          class="field"
          type="text"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellcheck={false}
          aria-label="Address"
          aria-invalid={refused.value}
          value={href.value}
          onInput={(event) => {
            href.value = event.currentTarget.value;
            refused.value = false;
          }}
        />
        {refused.value && <p class="err">Use a web address (https://), an email (mailto:) or a page path.</p>}
        <button type="submit" class="btn ink">
          Link
        </button>
      </form>
    </Sheet>
  );
}
