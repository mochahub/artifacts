import type { Artifact } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { Check, Copy, Eye, Link2Off, MessageCircle, Users, X } from "lucide-preact";
import { useEffect } from "preact/hooks";
import { api, message, post } from "../api.ts";
import { plural } from "../format.ts";
import { usePoll } from "../poll.ts";
import { meta } from "../session.ts";
import { Sheet } from "./sheets.tsx";

export type Level = "view" | "comment" | "publish" | "manage";
export const LEVELS: Record<Level, string> = {
  view: "Can view",
  comment: "Can comment",
  publish: "Can publish",
  manage: "Can manage",
};

type Inherited = {
  id: string;
  name: string;
  role: string;
  level: Level;
  via: "publisher" | "role" | "grant";
  sources: { name: string; slug: string }[];
  capped: boolean;
};
type Access = {
  people: { id: string; name: string; email: string; role: string; permission: Level }[];
  teams: { id: string; slug: string; name: string; permission: Level; viaToken: boolean; members: number }[];
  inherited: Inherited[];
  links: { id: string; permission: string; expiresAt: string | null }[];
};
export type Picked =
  | { kind: "person"; id: string; name: string; email: string; role: string }
  | { kind: "team"; id: string; slug: string; name: string; members: number };

const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});
const looksLikeEmail = (text: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);

/** A level, always in the same words. It's a native menu, so it works the same with a thumb. */
export function LevelSelect({
  value,
  levels,
  label,
  onChange,
}: {
  value: Level;
  levels: Level[];
  label: string;
  onChange(level: Level): void;
}) {
  return (
    <select
      class="level"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value as Level)}
    >
      {levels.map((level) => (
        <option value={level} key={level}>
          {LEVELS[level]}
        </option>
      ))}
    </select>
  );
}

/**
 * One field for people, teams and addresses. Each keystroke past the second looks people up; teams
 * are few, so they're fetched once. A reviewer who published something gets a 403 on both and can
 * still type an address.
 */
export function Picker({
  onPick,
  onEmail,
  placeholder = "Add a person, team or email",
  skip = [],
  teams = true,
}: {
  onPick(choice: Picked): void;
  onEmail?(email: string): void;
  placeholder?: string;
  skip?: string[];
  teams?: boolean;
}) {
  const query = useSignal("");
  const people = useSignal<Picked[]>([]);
  const allTeams = useSignal<Picked[]>([]);
  useEffect(() => {
    if (!teams) return;
    api<{ teams: Omit<Extract<Picked, { kind: "team" }>, "kind">[] }>("/api/teams")
      .then((body) => {
        allTeams.value = body.teams.map((team) => ({ ...team, kind: "team" }));
      })
      .catch(() => {});
  }, [allTeams, teams]);
  const q = query.value.trim();
  useEffect(() => {
    if (q.length < 2) {
      people.value = [];
      return;
    }
    const timer = setTimeout(() => {
      api<{ people: Omit<Extract<Picked, { kind: "person" }>, "kind">[] }>(
        `/api/people/search?q=${encodeURIComponent(q)}`,
      )
        .then((body) => {
          people.value = body.people.map((person) => ({ ...person, kind: "person" }));
        })
        .catch(() => {});
    }, 200);
    return () => clearTimeout(timer);
  }, [q, people]);
  const lower = q.toLowerCase();
  const matches =
    q.length < 2
      ? []
      : [...allTeams.value.filter((team) => team.name.toLowerCase().includes(lower)), ...people.value].filter(
          (choice) => !skip.includes(choice.id),
        );
  const finish = (action: () => void) => {
    action();
    query.value = "";
    people.value = [];
  };
  return (
    <>
      <input
        class="field grow"
        type="search"
        autocomplete="off"
        enterKeyHint="done"
        aria-label={placeholder}
        placeholder={placeholder}
        value={query.value}
        onInput={(e) => {
          query.value = e.currentTarget.value;
        }}
      />
      {(matches.length > 0 || (onEmail && looksLikeEmail(q))) && (
        <div class="group">
          {matches.map((choice) => (
            <button
              type="button"
              class="li btn-li"
              key={choice.id}
              onClick={() => finish(() => onPick(choice))}
            >
              {choice.kind === "team" ? <Users /> : <span class="av">{choice.name[0]}</span>}
              <div class="grow">
                <div class="tt">{choice.name}</div>
                <div class="ss">
                  {choice.kind === "team" ? plural(choice.members, "person", "people") : choice.email}
                </div>
              </div>
            </button>
          ))}
          {onEmail && looksLikeEmail(q) && !matches.some((c) => c.kind === "person" && c.email === q) && (
            <button type="button" class="li btn-li" onClick={() => finish(() => onEmail(q))}>
              <div class="grow">
                <div class="tt">Invite {q}</div>
                <div class="ss">As an outside person, with a link you send them</div>
              </div>
            </button>
          )}
        </div>
      )}
    </>
  );
}

const roleName = (role: string) => `${role[0]?.toUpperCase()}${role.slice(1)}`;

/** Why someone has access, in a word or two. A team links to itself, because that's where it changes. */
function Reason({ row }: { row: Inherited }) {
  if (row.via === "publisher") return <>, published this</>;
  if (row.via === "role") return <>, via role</>;
  return (
    <>
      {row.sources.map((source, i) => (
        <span key={source.slug}>
          {i === 0 ? ", via " : " and "}
          <a href={`/settings/teams/${source.slug}`}>{source.name}</a>
        </span>
      ))}
      {row.capped && ", capped by role"}
    </>
  );
}

export function InheritedRows({ rows }: { rows: Inherited[] }) {
  if (rows.length === 0) return null;
  return (
    <div class="group">
      {rows.map((row) => (
        <div class="li" key={row.id}>
          <span class="av">{row.name[0]}</span>
          <div class="grow">
            <div class="tt">{row.name}</div>
            <div class="ss">
              {row.role !== "member" ? `${roleName(row.role)}, ` : ""}
              {LEVELS[row.level]}
              <Reason row={row} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** One artifact's access (05·1): who has it and why, then links, which are shown once and revoked by row. */
export function ShareSheet({
  artifact,
  onClose,
  onChanged,
}: {
  artifact: Artifact;
  onClose(): void;
  onChanged(): void;
}) {
  const access = usePoll<Access>(`/api/artifacts/${artifact.id}/access`, 60_000);
  const permission = useSignal<"view" | "comment">("comment");
  const expires = useSignal<string>("");
  const url = useSignal<string | null>(null);
  const adding = useSignal<Level>("comment");
  const error = useSignal<string | null>(null);
  const data = access.data.value;

  async function run(work: () => Promise<void>) {
    error.value = null;
    try {
      await work();
      await access.refresh();
    } catch (failure) {
      error.value = message(failure);
    }
  }
  const createLink = () =>
    run(async () => {
      const made = await post<{ url: string }>(`/api/artifacts/${artifact.id}/links`, {
        permission: permission.value,
        expiresIn: expires.value || null,
      });
      url.value = made.url;
      copy(made.url);
    });
  const setPerson = (email: string, level: Level) =>
    run(async () => {
      const made = await post<{ url?: string }>(`/api/artifacts/${artifact.id}/access`, {
        email,
        permission: level,
      });
      if (made.url) {
        url.value = made.url;
        copy(made.url);
      }
    });
  const setTeam = (id: string, level: Level) =>
    run(async () => {
      await api(`/api/artifacts/${artifact.id}/teams/${id}`, { method: "PUT", json: { permission: level } });
    });
  const levels: Level[] = ["view", "comment", "publish"];

  return (
    <Sheet title={`Share ${artifact.title}`} onClose={onClose}>
      <span class="gh">Who has access</span>
      <div class="seg">
        {(["org", "me"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={artifact.visibility === value}
            onClick={() =>
              run(async () => {
                await api(`/api/artifacts/${artifact.id}`, { method: "PATCH", json: { visibility: value } });
                onChanged();
              })
            }
          >
            {value === "org" ? `Everyone in ${meta.value?.orgName}` : "Only people added"}
          </button>
        ))}
      </div>
      <div class="addrow">
        <Picker
          skip={[...(data?.people ?? []), ...(data?.teams ?? [])].map((row) => row.id)}
          onPick={(choice) =>
            choice.kind === "team" ? setTeam(choice.id, adding.value) : setPerson(choice.email, adding.value)
          }
          onEmail={(email) => setPerson(email, adding.value)}
        />
        <LevelSelect
          value={adding.value}
          levels={levels}
          label="Level for who you add"
          onChange={(level) => {
            adding.value = level;
          }}
        />
      </div>
      {((data?.teams.length ?? 0) > 0 || (data?.people.length ?? 0) > 0) && (
        <div class="group">
          {data?.teams.map((team) => (
            <div class="li" key={team.id}>
              <Users />
              <div class="grow">
                <div class="tt">
                  <a href={`/settings/teams/${team.slug}`}>{team.name}</a>
                </div>
                <div class="ss">
                  {plural(team.members, "person", "people")}
                  {team.viaToken && ", added by an agent"}
                </div>
                {team.viaToken && (
                  <button type="button" class="linkish" onClick={() => setTeam(team.id, team.permission)}>
                    Confirm so they can approve
                  </button>
                )}
              </div>
              <LevelSelect
                value={team.permission}
                levels={levels}
                label={`Level for ${team.name}`}
                onChange={(level) => setTeam(team.id, level)}
              />
              <button
                type="button"
                class="icon-btn"
                aria-label={`Remove ${team.name}`}
                onClick={() =>
                  run(() => api(`/api/artifacts/${artifact.id}/teams/${team.id}`, { method: "DELETE" }))
                }
              >
                <X />
              </button>
            </div>
          ))}
          {data?.people.map((person) => (
            <div class="li" key={person.id}>
              <span class="av">{person.name[0]}</span>
              <div class="grow">
                <div class="tt">{person.name}</div>
                {person.role !== "member" && <div class="ss">{roleName(person.role)}</div>}
              </div>
              <LevelSelect
                value={person.permission}
                levels={person.role === "outside" ? ["view", "comment"] : levels}
                label={`Level for ${person.name}`}
                onChange={(level) => setPerson(person.email, level)}
              />
              <button
                type="button"
                class="icon-btn"
                aria-label={`Remove ${person.name}`}
                onClick={() =>
                  run(() => api(`/api/artifacts/${artifact.id}/access/${person.id}`, { method: "DELETE" }))
                }
              >
                <X />
              </button>
            </div>
          ))}
        </div>
      )}
      <InheritedRows rows={data?.inherited ?? []} />
      {error.value && <p class="err">{error.value}</p>}
      <span class="gh">Anyone with the link</span>
      <div class="group">
        {(["view", "comment"] as const).map((value) => (
          <button
            type="button"
            class="li btn-li"
            key={value}
            onClick={() => {
              permission.value = value;
            }}
          >
            {value === "view" ? <Eye /> : <MessageCircle />}
            <div class="grow">
              <div class="tt">{value === "view" ? "View" : "View and comment"}</div>
            </div>
            {permission.value === value && <Check />}
          </button>
        ))}
      </div>
      <select
        class="field"
        aria-label="Expires"
        value={expires.value}
        onChange={(e) => {
          expires.value = e.currentTarget.value;
        }}
      >
        <option value="">Never expires</option>
        <option value="1d">Expires in 1 day</option>
        <option value="7d">Expires in 7 days</option>
        <option value="30d">Expires in 30 days</option>
      </select>
      <button type="button" class="btn ink" onClick={createLink}>
        <Copy />
        Copy link
      </button>
      {url.value && (
        <div class="card" style="padding:10px 14px">
          <div class="mono" style="font-size:14px;overflow-wrap:anywhere" data-testid="share-url">
            {url.value}
          </div>
        </div>
      )}
      {(data?.links.length ?? 0) > 0 && (
        <div class="group">
          {data?.links.map((link) => (
            <div class="li" key={link.id}>
              <div class="grow">
                <div class="tt">{link.permission === "view" ? "View link" : "Comment link"}</div>
                <div class="ss">
                  {link.expiresAt ? `Until ${new Date(link.expiresAt).toLocaleDateString()}` : "No expiry"}
                </div>
              </div>
              <button
                type="button"
                class="icon-btn"
                aria-label="Revoke this link"
                onClick={() =>
                  run(() => api(`/api/artifacts/${artifact.id}/links/${link.id}`, { method: "DELETE" }))
                }
              >
                <Link2Off />
              </button>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}
