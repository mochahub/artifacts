import type { ActivityItem, ActivityKind, ActivityPage } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { AgentMark, Avatar } from "../components/cards.tsx";
import { SignedIn } from "../components/guard.tsx";
import { Loaded } from "../components/loaded.tsx";
import { PlaceholderRows } from "../components/placeholder.tsx";
import { Shell } from "../components/shell.tsx";
import { agentShort, ago } from "../format.ts";
import { artifactHref } from "../paths.ts";
import { usePoll } from "../poll.ts";
import { useTitle } from "../title.ts";

/** The payload fields the feed reads. Each kind writes its own (02). */
type Item = ActivityItem & {
  payload: {
    version?: number;
    title?: string;
    thread?: number;
    from?: number;
    team?: string;
    person?: string;
    project?: string;
  };
};

const VERBS: Record<ActivityKind, string> = {
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
  team_created: "created the team",
  team_deleted: "deleted the team",
  team_member_added: "added someone to",
  team_member_removed: "removed someone from",
  project_access_changed: "changed who has access to",
  identity_linked: "connected Google",
  checkpointed: "saved a version of",
  edited: "edited",
  suggested: "suggested a change to",
  suggestion_accepted: "accepted a suggestion on",
  suggestion_rejected: "turned down a suggestion on",
  run_started: "started an agent on",
  run_finished: "finished an agent run on",
  maintained_changed: "changed who maintains",
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

function Feed() {
  const filter = useSignal("all");
  const poll = usePoll<ActivityPage & { items: Item[] }>(`/api/activity?filter=${filter.value}`, 60_000);
  useTitle("Activity");

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
      <Loaded from={[poll]} value={poll.data.value?.items} placeholder={<PlaceholderRows rows={4} />}>
        {(items) => (
          <>
            {!poll.loading && items.length === 0 && <div class="empty">Nothing yet.</div>}
            <Days items={items} />
          </>
        )}
      </Loaded>
    </Shell>
  );
}

function Days({ items }: { items: Item[] }) {
  const days = [...new Set(items.map((item) => day(item.createdAt)))];
  return (
    <>
      {days.map((label) => (
        <>
          <span class="gh" key={label}>
            {label}
          </span>
          <div class="group">
            {items
              .filter((item) => day(item.createdAt) === label)
              .map((item) => {
                const title =
                  item.artifact?.title ??
                  item.payload.title ??
                  item.payload.project ??
                  item.payload.team ??
                  "";
                const version = item.payload.version ? ` v${item.payload.version}` : "";
                return (
                  <a class="li" key={item.id} href={item.artifact ? artifactHref(item.artifact) : undefined}>
                    {item.agent ? <AgentMark /> : <Avatar name={item.actor} />}
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
    </>
  );
}

export const Activity = () => (
  <SignedIn>
    <Feed />
  </SignedIn>
);
