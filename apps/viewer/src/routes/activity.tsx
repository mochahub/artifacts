import { useSignal } from "@preact/signals";
import { Shell } from "../components/shell.tsx";
import { agentInitials, agentShort, ago } from "../format.ts";
import { usePoll } from "../poll.ts";
import { SignedIn } from "./guard.tsx";

type Item = {
  id: string;
  kind: string;
  actor: string;
  agent: string | null;
  artifact: { title: string; slug: string; project: string } | null;
  payload: { version?: number; title?: string; thread?: number; from?: number };
  createdAt: string;
};

const VERBS: Record<string, string> = {
  published: "published",
  restored: "restored",
  commented: "commented on",
  replied: "replied on",
  fixed: "marked a thread fixed on",
  resolved: "resolved a thread on",
  reopened: "reopened a thread on",
  approved: "approved",
  changes_requested: "requested changes on",
  archived: "archived",
  unarchived: "unarchived",
  deleted: "moved to Recently deleted:",
  undeleted: "restored",
  purged: "erased",
  version_deleted: "removed a version of",
  version_undeleted: "brought back a version of",
  version_named: "named a version of",
  shared: "shared",
  joined: "joined",
  recovered: "recovered an owner account",
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

function Feed() {
  const filter = useSignal("all");
  const { data } = usePoll<{ items: Item[] }>(`/api/activity?filter=${filter.value}`, 60_000);
  const items = data.value?.items ?? [];
  const days = [...new Set(items.map((item) => day(item.createdAt)))];
  return (
    <Shell>
      <h1 class="h1 l">Activity</h1>
      <div class="seg">
        {[
          ["all", "All"],
          ["agents", "Agents"],
          ["people", "People"],
        ].map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={filter.value === value}
            onClick={() => {
              filter.value = value as string;
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {data.value && items.length === 0 && <div class="empty">Nothing yet.</div>}
      {days.map((label) => (
        <>
          <span class="gh" key={label}>
            {label}
          </span>
          <div class="group">
            {items
              .filter((item) => day(item.createdAt) === label)
              .map((item) => {
                const title = item.artifact?.title ?? item.payload.title ?? "";
                const version = item.payload.version ? ` v${item.payload.version}` : "";
                return (
                  <a
                    class="li"
                    key={item.id}
                    href={item.artifact ? `/${item.artifact.project}/${item.artifact.slug}` : undefined}
                  >
                    {item.agent ? (
                      <span class="av agent">{agentInitials(item.agent)}</span>
                    ) : (
                      <span class="av">{item.actor[0]}</span>
                    )}
                    <div class="grow">
                      <div class="tt" style="font-weight:400">
                        <b>{item.agent ? agentShort(item.agent) : item.actor}</b> {VERBS[item.kind]} {title}
                        {version}
                      </div>
                      <div class="ss">{ago(item.createdAt)}</div>
                    </div>
                  </a>
                );
              })}
          </div>
        </>
      ))}
    </Shell>
  );
}

export const Activity = () => (
  <SignedIn>
    <Feed />
  </SignedIn>
);
