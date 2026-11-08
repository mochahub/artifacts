import type { LibrarianRun, ProjectRow } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { useRoute } from "preact-iso";
import { api, post } from "../api.ts";
import { SignedIn } from "../components/guard.tsx";
import { useAction } from "../components/reauth.tsx";
import { Frame, isAdmin } from "../routes/settings/frame.tsx";
import { safeError, statusLabel, usd } from "./common.ts";
import "./librarian.css";
export function RunLogs() {
  return (
    <SignedIn>
      {isAdmin() ? (
        <Logs />
      ) : (
        <Frame title="Run logs">
          <p>Admin access required.</p>
        </Frame>
      )}
    </SignedIn>
  );
}
function Logs() {
  const { params } = useRoute();
  const id = params.id;
  const runs = useSignal<LibrarianRun[]>([]),
    cursor = useSignal<string | undefined>(undefined),
    events = useSignal<{ id: string; code: string; createdAt: string }[]>([]),
    eventCursor = useSignal<string | undefined>(undefined),
    error = useSignal(""),
    busy = useSignal(false),
    loaded = useSignal(false);
  const projects = useSignal<ProjectRow[]>([]);
  const action = useAction();
  function perform(work: () => Promise<void>) {
    return action.run(async () => {
      busy.value = true;
      error.value = "";
      try {
        await work();
      } catch (failure) {
        if (failure instanceof Error && "code" in failure && failure.code === "recent_auth_required")
          throw failure;
        error.value = safeError(failure);
      } finally {
        busy.value = false;
      }
    });
  }
  async function load(more = false) {
    if (id) {
      projects.value = await api<ProjectRow[]>("/api/projects");
      runs.value = [await api<LibrarianRun>(`/api/librarian/runs/${encodeURIComponent(id)}`)];
      await loadEvents();
    } else {
      const body = await api<{ runs: LibrarianRun[]; nextCursor?: string }>(
        `/api/librarian/runs${more && cursor.value ? `?cursor=${encodeURIComponent(cursor.value)}` : ""}`,
      );
      runs.value = more ? [...runs.value, ...body.runs] : body.runs;
      cursor.value = body.nextCursor;
    }
    loaded.value = true;
  }
  async function loadEvents(more = false) {
    const body = await api<{ events: typeof events.value; nextCursor?: string }>(
      `/api/librarian/runs/${encodeURIComponent(id ?? "")}/events${more && eventCursor.value ? `?cursor=${encodeURIComponent(eventCursor.value)}` : ""}`,
    );
    events.value = more ? [...events.value, ...body.events] : body.events;
    eventCursor.value = body.nextCursor;
  }
  useEffect(() => {
    perform(() => load());
  }, [id]);
  return (
    <Frame
      title={id ? "Run log" : "Run logs"}
      back={id ? "/settings/librarian/runs" : "/settings/librarian"}
      backLabel={id ? "Run logs" : "Librarian"}
    >
      <div class="librarian">
        <p>Admin only. Historical runs do not indicate that Librarian is currently enabled.</p>
        {runs.value.map((run) => (
          <article class="entry" key={run.id}>
            <h2 class="h2">{statusLabel(run.state)}</h2>
            <p>
              {run.startedAt ? new Date(run.startedAt).toLocaleString() : "Not started"}, {run.model}
            </p>
            <p>
              Settled {usd(run.usage.settledMicrousd)}, uncertain {usd(run.usage.uncertainMicrousd)}, reserved{" "}
              {usd(run.usage.reservedMicrousd)}
            </p>
            {run.result.proposalIds.map((proposalId) => {
              const wiki = projects.value.find((p) => p.id === run.wikiId);
              return wiki ? (
                <p key={proposalId}>
                  <a
                    class="agent-output"
                    href={`/wikis/${encodeURIComponent(wiki.slug)}/proposals/${encodeURIComponent(proposalId)}`}
                  >
                    Review proposed page
                  </a>
                </p>
              ) : null;
            })}
            {!id && <a href={`/settings/librarian/runs/${run.id}`}>View run log</a>}
            {["queued", "running", "waiting_human"].includes(run.state) && (
              <button
                class="btn soft"
                disabled={busy.value}
                type="button"
                onClick={() =>
                  perform(async () => {
                    await post(`/api/librarian/runs/${run.id}/cancel`);
                    await load();
                  })
                }
              >
                Cancel run
              </button>
            )}
          </article>
        ))}
        {loaded.value && !runs.value.length && <p>No runs recorded.</p>}
        {events.value.map((event) => (
          <p class="entry" key={event.id}>
            <time>{new Date(event.createdAt).toLocaleString()}</time>
            <br />
            {statusLabel(event.code)}
          </p>
        ))}
        {id && eventCursor.value && (
          <button
            class="btn soft"
            disabled={busy.value}
            type="button"
            onClick={() => perform(() => loadEvents(true))}
          >
            Load more events
          </button>
        )}
        {!id && cursor.value && (
          <button
            class="btn soft"
            disabled={busy.value}
            type="button"
            onClick={() => perform(() => load(true))}
          >
            Load more runs
          </button>
        )}
        {error.value && <p role="alert">{error.value}</p>}
        <button class="btn soft" disabled={busy.value} type="button" onClick={() => perform(() => load())}>
          Refresh runs
        </button>
        {action.sheet}
      </div>
    </Frame>
  );
}
