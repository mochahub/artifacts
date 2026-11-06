import { DAY_MS, PURGE_DAYS } from "@artifacts/schema/constants";
import { useSignal } from "@preact/signals";
import { del, post } from "../../api.ts";
import { SignedIn } from "../../components/guard.tsx";
import { useAction } from "../../components/reauth.tsx";
import { Sheet } from "../../components/sheet.tsx";
import { plural } from "../../format.ts";
import { usePoll } from "../../poll.ts";
import { Frame } from "./frame.tsx";

type Row = {
  kind: "artifact" | "version";
  artifact: { id: string; title: string };
  version?: number;
  deletedBy: string | null;
  purgeAfter: string;
};

const daysLeft = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / DAY_MS));
const path = (row: Row) =>
  row.kind === "artifact"
    ? `/api/artifacts/${row.artifact.id}`
    : `/api/artifacts/${row.artifact.id}/versions/${row.version}`;

function List() {
  const list = usePoll<Row[]>("/api/deleted", 60_000);
  const action = useAction({ after: list.refresh });
  const confirming = useSignal(false);
  const eraseAll = () =>
    action.run(async () => {
      for (const row of list.data.value ?? []) await del(path(row));
    });

  const rows = list.data.value ?? [];
  return (
    <Frame title="Recently deleted">
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
                onClick={() => action.run(() => post(`${path(row)}/undelete`))}
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
      {action.error.value && <p class="err">{action.error.value}</p>}
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
        Erased for good after {PURGE_DAYS} days. Agents can move things here, but only a person can erase
        them.
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
      {action.sheet}
    </Frame>
  );
}

export const RecentlyDeleted = () => (
  <SignedIn>
    <List />
  </SignedIn>
);
