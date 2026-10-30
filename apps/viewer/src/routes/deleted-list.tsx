import { useSignal } from "@preact/signals";
import { ChevronLeft } from "lucide-preact";
import { ApiFailure, api, post } from "../api.ts";
import { ReauthSheet } from "../components/reauth.tsx";
import { Sheet } from "../components/sheets.tsx";
import { plural } from "../format.ts";
import { usePoll } from "../poll.ts";
import { SignedIn } from "./guard.tsx";

type Row = {
  kind: "artifact" | "version";
  artifact: { id: string; title: string };
  version?: number;
  deletedBy: string | null;
  purgeAfter: string;
};

const daysLeft = (iso: string) =>
  Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / (24 * 3600_000)));
const path = (row: Row) =>
  row.kind === "artifact"
    ? `/api/artifacts/${row.artifact.id}`
    : `/api/artifacts/${row.artifact.id}/versions/${row.version}`;

function List() {
  const list = usePoll<Row[]>("/api/deleted", 60_000);
  const retry = useSignal<(() => Promise<void>) | null>(null);
  const error = useSignal<string | null>(null);
  const confirming = useSignal(false);

  async function run(work: () => Promise<void>) {
    error.value = null;
    try {
      await work();
      await list.refresh();
    } catch (failure) {
      if (failure instanceof ApiFailure && failure.code === "recent_auth_required") retry.value = work;
      else error.value = failure instanceof ApiFailure ? failure.message : "Something went wrong.";
    }
  }
  const eraseAll = () =>
    run(async () => {
      for (const row of list.data.value ?? []) await api(path(row), { method: "DELETE" });
    });

  const rows = list.data.value ?? [];
  return (
    <main class="main">
      <a class="back" href="/settings">
        <ChevronLeft />
        Settings
      </a>
      <h1 class="h1">Recently deleted</h1>
      {list.data.value && rows.length === 0 && <div class="empty">Nothing here.</div>}
      {rows.length > 0 && (
        <div class="group">
          {rows.map((row) => (
            <div class="li" key={`${row.artifact.id}${row.version ?? ""}`}>
              <div class="grow">
                <div class="tt">
                  {row.artifact.title}
                  {row.version ? `, v${row.version}` : ""}
                </div>
                <div class="ss">{plural(daysLeft(row.purgeAfter), "day")} left</div>
              </div>
              <button
                type="button"
                class="btn soft fit"
                onClick={() => run(() => post(`${path(row)}/undelete`))}
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
      {error.value && <p class="err">{error.value}</p>}
      {rows.length > 0 && (
        <button
          type="button"
          class="btn soft"
          style="color:var(--warn-word)"
          onClick={() => {
            confirming.value = true;
          }}
        >
          Delete all now
        </button>
      )}
      <p class="fn">
        Erased for good after 30 days. Agents can move things here, but only a person can erase them.
      </p>
      {confirming.value && (
        <Sheet
          title={`Erase ${plural(rows.length, "item")} for good?`}
          onClose={() => {
            confirming.value = false;
          }}
        >
          <div class="group">
            {rows.map((row) => (
              <div class="li" key={`${row.artifact.id}${row.version ?? ""}`}>
                <div class="grow">
                  <div class="tt">
                    {row.artifact.title}
                    {row.version ? `, v${row.version}` : ""}
                  </div>
                  <div class="ss">{row.deletedBy ? `Deleted by ${row.deletedBy}` : ""}</div>
                </div>
              </div>
            ))}
          </div>
          <p class="sub">Versions, comments, saved data and backends go now. This can't be undone.</p>
          <button
            type="button"
            class="btn soft"
            style="color:var(--warn-word)"
            onClick={() => {
              confirming.value = false;
              eraseAll();
            }}
          >
            Erase them now
          </button>
        </Sheet>
      )}
      {retry.value && (
        <ReauthSheet
          onCancel={() => {
            retry.value = null;
          }}
          onDone={() => {
            const work = retry.value;
            retry.value = null;
            if (work) run(work);
          }}
        />
      )}
    </main>
  );
}

export const RecentlyDeleted = () => (
  <SignedIn>
    <List />
  </SignedIn>
);
