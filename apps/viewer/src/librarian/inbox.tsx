import type { LibrarianInbox, ProjectRow, SourceInput } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { useRoute } from "preact-iso";
import { api, post } from "../api.ts";
import { SignedIn } from "../components/guard.tsx";
import { Frame, isAdmin } from "../routes/settings/frame.tsx";
import { safeError, statusLabel } from "./common.ts";
import "./librarian.css";

export function Inbox() {
  return (
    <SignedIn>
      <InboxView />
    </SignedIn>
  );
}
function InboxView() {
  const { params } = useRoute();
  const slug = params.wiki ?? "";
  const query = new URLSearchParams(location.search);
  const sharedId = useSignal(query.get("share"));
  const title = useSignal(query.get("title") ?? "");
  const content = useSignal(query.get("text") ?? "");
  const url = useSignal(query.get("url") ?? "");
  const kind = useSignal<"text" | "url" | "file">(query.get("url") ? "url" : "text");
  const wiki = useSignal(slug);
  const projects = useSignal<ProjectRow[]>([]);
  const items = useSignal<LibrarianInbox[]>([]);
  const cursor = useSignal<string | null>(null);
  const loaded = useSignal(false);
  const busy = useSignal(false);
  const error = useSignal("");
  const notice = useSignal("");
  const file = useSignal<File | null>(null);
  const note = useSignal("");
  const requestId = useSignal(crypto.randomUUID());
  const base = `/api/wikis/${encodeURIComponent(wiki.value)}/inbox`;
  async function perform(work: () => Promise<void>) {
    busy.value = true;
    error.value = "";
    try {
      await work();
    } catch (failure) {
      error.value = safeError(failure);
    } finally {
      busy.value = false;
    }
  }
  async function list(more = false) {
    if (!wiki.value) return;
    const result = await api<{ items: LibrarianInbox[]; nextCursor?: string }>(
      `${base}${more && cursor.value ? `?cursor=${encodeURIComponent(cursor.value)}` : ""}`,
    );
    items.value = more ? [...items.value, ...result.items] : result.items;
    cursor.value = result.nextCursor ?? null;
    loaded.value = true;
  }
  useEffect(() => {
    perform(async () => {
      projects.value = (await api<ProjectRow[]>("/api/projects")).filter((p) => p.kind === "wiki");
      if (sharedId.value) {
        const response = await fetch(`/_librarian-share/${encodeURIComponent(sharedId.value)}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          error.value = "Shared content expired. Share it again or choose a file below.";
          return;
        }
        const form = await response.formData();
        title.value = String(form.get("title") ?? "").slice(0, 256);
        content.value = String(form.get("text") ?? "");
        url.value = String(form.get("url") ?? "");
        const shared = form.get("files");
        if (shared instanceof File && shared.size) {
          file.value = shared;
          kind.value = "file";
        } else kind.value = url.value ? "url" : "text";
        sharedId.value = null;
      }
    });
    // Shared text is held only in this page, never retained in history or storage.
    if (location.search) history.replaceState(null, "", location.pathname);
  }, []);
  useEffect(() => {
    items.value = [];
    loaded.value = false;
    if (wiki.value) perform(() => list());
  }, [wiki.value]);
  async function submit() {
    let source: SourceInput;
    if (kind.value === "file") {
      const chosen = file.value;
      if (!chosen || chosen.size < 1 || chosen.size > 10485760) throw new Error("invalid");
      const bytes = await chosen.arrayBuffer();
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      const contentType = chosen.type || (chosen.name.endsWith(".md") ? "text/markdown" : "text/plain");
      const ticket = await post<{ uploadId: string; url: string; headers?: Record<string, string> }>(
        `${base}/uploads`,
        { name: chosen.name, size: chosen.size, contentType, sha256 },
      );
      const uploaded = await fetch(ticket.url, {
        method: "PUT",
        headers: ticket.headers,
        body: bytes,
        credentials: "omit",
      });
      if (!uploaded.ok) throw new Error("upload");
      source = { kind: "file", uploadId: ticket.uploadId, title: title.value || chosen.name };
    } else if (kind.value === "url") {
      const parsed = new URL(url.value);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        parsed.port ||
        url.value.length > 2048
      )
        throw new Error("invalid");
      source = { kind: "url", url: url.value, title: title.value || undefined };
    } else {
      if (!content.value.trim() || new TextEncoder().encode(content.value).length > 1048576)
        throw new Error("invalid");
      source = { kind: "text", text: content.value, title: title.value };
    }
    const saved = await post<LibrarianInbox & { message: string }>(base, {
      idempotencyKey: requestId.value,
      source,
      note: note.value || undefined,
    });
    // Use bounded known copy, never echo arbitrary server text.
    notice.value =
      saved.message === "Saved to inbox. Librarian is off."
        ? saved.message
        : "Saved to inbox. Processing is not yet complete.";
    content.value = "";
    url.value = "";
    title.value = "";
    file.value = null;
    note.value = "";
    requestId.value = crypto.randomUUID();
    await list();
  }
  const changed = () => {
    requestId.value = crypto.randomUUID();
  };
  return (
    <Frame
      title="Sources"
      back={slug ? `/${encodeURIComponent(slug)}` : "/projects"}
      backLabel={slug ? "Wiki" : "Projects"}
    >
      <div class="librarian">
        <p>
          Adding a source only queues it. If Librarian is off, it stays queued until an admin enables runs.
        </p>
        {isAdmin() && <a href="/settings/librarian">Librarian settings</a>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            perform(submit);
          }}
        >
          <label for="inbox-wiki">Target wiki</label>
          <select
            class="field"
            id="inbox-wiki"
            required
            value={wiki.value}
            disabled={busy.value}
            onChange={(e) => {
              wiki.value = e.currentTarget.value;
              changed();
            }}
          >
            <option value="">Choose a wiki</option>
            {projects.value.map((p) => (
              <option key={p.id} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
          <div class="seg">
            {(["text", "file", "url"] as const).map((k) => (
              <button
                type="button"
                key={k}
                aria-pressed={kind.value === k}
                onClick={() => {
                  kind.value = k;
                  changed();
                }}
              >
                {k === "url" ? "URL" : k === "file" ? "File" : "Text"}
              </button>
            ))}
          </div>
          <label for="source-title">Title</label>
          <input
            class="field"
            id="source-title"
            required={kind.value === "text"}
            maxLength={256}
            value={title.value}
            onInput={(e) => {
              title.value = e.currentTarget.value;
              changed();
            }}
          />
          {kind.value === "text" && (
            <>
              <label for="source-text">Text, up to 1 MiB</label>
              <textarea
                class="field"
                id="source-text"
                required
                value={content.value}
                onInput={(e) => {
                  content.value = e.currentTarget.value;
                  changed();
                }}
              />
            </>
          )}
          {kind.value === "url" && (
            <>
              <label for="source-url">Public HTTPS URL</label>
              <input
                class="field"
                id="source-url"
                type="url"
                required
                maxLength={2048}
                value={url.value}
                onInput={(e) => {
                  url.value = e.currentTarget.value;
                  changed();
                }}
              />
              <p class="ss">Public pages only. No sign-in, redirects or private addresses.</p>
            </>
          )}
          {kind.value === "file" && (
            <>
              <label for="source-file">File, up to 10 MiB</label>
              <input
                id="source-file"
                type="file"
                required={!file.value}
                accept=".txt,.md,.html,.htm,.pdf,text/plain,text/markdown,text/html,application/pdf"
                onChange={(e) => {
                  file.value = e.currentTarget.files?.[0] ?? null;
                  changed();
                }}
              />
              <p class="ss">
                {file.value ? `Selected file: ${file.value.name}. ` : ""}Text, Markdown, HTML or text-bearing
                PDF. No OCR.
              </p>
            </>
          )}
          <label for="source-note">Note, optional</label>
          <textarea
            class="field"
            id="source-note"
            maxLength={2000}
            value={note.value}
            onInput={(e) => {
              note.value = e.currentTarget.value;
              changed();
            }}
          />
          <p>
            Confirm the target wiki before submitting. Sources are untrusted; a person reviews proposed pages.
          </p>
          <button type="submit" class="btn ink" disabled={busy.value || !wiki.value}>
            Add to queue
          </button>
        </form>
        {notice.value && <p role="status">{notice.value}</p>}
        {error.value && <p role="alert">{error.value}</p>}
        {wiki.value && (
          <section>
            <h2 class="h2">Queue</h2>
            <button
              class="btn soft"
              type="button"
              disabled={busy.value}
              onClick={() => perform(() => list())}
            >
              Refresh queue
            </button>
            {loaded.value && items.value.length === 0 && <p>No sources in your inbox.</p>}
            {items.value.map((item) => (
              <article class="entry" key={item.id}>
                <strong>{item.title}</strong>
                <p>
                  {item.kind}, {statusLabel(item.status)}, {new Date(item.submittedAt).toLocaleString()}
                </p>
                {item.status === "waiting_human" && (
                  <p class="agent-output">
                    Librarian is waiting for human review. Review suggestions and open questions on the
                    affected pages.
                  </p>
                )}
                {item.status === "failed" && <p>Source could not be processed.</p>}
                {item.runId && isAdmin() && (
                  <a href={`/settings/librarian/runs/${encodeURIComponent(item.runId)}`}>View run</a>
                )}
                {!["done", "cancelled", "failed"].includes(item.status) && (
                  <button
                    class="btn soft"
                    type="button"
                    disabled={busy.value}
                    onClick={() =>
                      perform(async () => {
                        await post(`${base}/${encodeURIComponent(item.id)}/cancel`);
                        await list();
                      })
                    }
                  >
                    Cancel source
                  </button>
                )}
              </article>
            ))}
            {cursor.value && (
              <button
                class="btn soft"
                type="button"
                disabled={busy.value}
                onClick={() => perform(() => list(true))}
              >
                Load more sources
              </button>
            )}
          </section>
        )}
      </div>
    </Frame>
  );
}
