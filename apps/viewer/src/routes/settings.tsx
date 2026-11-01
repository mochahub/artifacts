import { useSignal } from "@preact/signals";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Globe,
  KeyRound,
  Laptop,
  Lock,
  Plus,
  Trash2,
  Users,
  X,
} from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useLocation, useRoute } from "preact-iso";
import { ApiFailure, api, post } from "../api.ts";
import { ReauthSheet } from "../components/reauth.tsx";
import { LEVELS, Picker } from "../components/share.tsx";
import { Sheet } from "../components/sheets.tsx";
import { ago, plural } from "../format.ts";
import {
  canPush,
  clearOffline,
  currentSubscription,
  needsInstall,
  turnOffNotifications,
  turnOnNotifications,
} from "../notify.ts";
import { addPasskey, passkeyName } from "../passkey.ts";
import { usePoll } from "../poll.ts";
import { me, meta } from "../session.ts";
import { SignedIn } from "./guard.tsx";

const ADMIN = () => me.value?.role === "owner" || me.value?.role === "admin";
const MEMBER_OR_UP = () => ADMIN() || me.value?.role === "member";
const message = (failure: unknown) =>
  failure instanceof ApiFailure ? failure.message : "Something went wrong.";

function Frame({
  title,
  back = "/settings",
  backLabel = "Settings",
  children,
}: {
  title: string;
  back?: string;
  backLabel?: string;
  children: ComponentChildren;
}) {
  return (
    <main class="main">
      <a class="back" href={back}>
        <ChevronLeft />
        {backLabel}
      </a>
      <h1 class="h1">{title}</h1>
      {children}
    </main>
  );
}

/** Runs something that may need a fresh sign-in, and retries after the sheet (04). */
function useRecent() {
  const pending = useSignal<(() => Promise<void>) | null>(null);
  const error = useSignal<string | null>(null);
  async function run(work: () => Promise<void>) {
    error.value = null;
    try {
      await work();
    } catch (failure) {
      if (failure instanceof ApiFailure && failure.code === "recent_auth_required") pending.value = work;
      else error.value = message(failure);
    }
  }
  const sheet = pending.value ? (
    <ReauthSheet
      onCancel={() => {
        pending.value = null;
      }}
      onDone={() => {
        const work = pending.value;
        pending.value = null;
        if (work) run(work);
      }}
    />
  ) : null;
  return { run, error, sheet };
}

function Index() {
  const admin = ADMIN();
  const rows = [
    ["/settings/sign-in", "Sign-in", "Passkeys, password and sessions"],
    ["/settings/notifications", "Notifications", "On this device"],
    ...(MEMBER_OR_UP() ? [["/settings/teams", "Teams", "Who works together, and what they share"]] : []),
    ...(admin
      ? [
          ["/settings/people", "People", "Members, outside people and invites"],
          ["/settings/tokens", "Tokens", "For CI and headless agents"],
          ["/settings/domains", "Domains", "Where this deployment answers"],
          ["/settings/org", "Organization", "Name, defaults and link sharing"],
          ["/settings/brand", "Brand", "How your templates look"],
        ]
      : []),
    ["/settings/deleted", "Recently deleted", "Kept for 30 days"],
  ];
  return (
    <main class="main">
      <a class="back" href="/">
        <ChevronLeft />
        Review
      </a>
      <h1 class="h1">Settings</h1>
      <div class="group">
        {rows.map(([href, title, sub]) => (
          <a class="li" href={href} key={href}>
            <div class="grow">
              <div class="tt">{title}</div>
              <div class="ss">{sub}</div>
            </div>
            <ChevronRight class="chev" />
          </a>
        ))}
      </div>
      <button
        type="button"
        class="btn soft"
        onClick={async () => {
          // Before the session ends: the next person on this device shouldn't get these.
          await turnOffNotifications().catch(() => {});
          await post("/api/auth/logout");
          await clearOffline();
          location.href = "/sign-in";
        }}
      >
        Sign out
      </button>
    </main>
  );
}

type Keys = {
  passkeys: { id: string; name: string | null; createdAt: string; lastUsedAt: string | null }[];
  passwordSetAt: string | null;
};
type Session = {
  id: string;
  kind: "session" | "cli" | "connector";
  name: string;
  userAgent: string | null;
  lastSeenAt: string | null;
  current: boolean;
};

function SignIn() {
  const keys = usePoll<Keys>("/api/me/passkeys", 60_000);
  const sessions = usePoll<Session[]>("/api/me/sessions", 60_000);
  const recent = useRecent();
  const changing = useSignal(false);
  const password = useSignal("");
  const add = () =>
    recent.run(async () => {
      await addPasskey(passkeyName());
      await keys.refresh();
    });
  const others = meta.value?.viewerOrigins.map((origin) => new URL(origin).hostname).join(" and ");
  return (
    <Frame title="Sign-in">
      <span class="gh">Passkeys</span>
      {(keys.data.value?.passkeys.length ?? 0) > 0 && (
        <div class="group">
          {keys.data.value?.passkeys.map((key) => (
            <div class="li" key={key.id}>
              <KeyRound />
              <div class="grow">
                <div class="tt">{key.name}</div>
                <div class="ss">Added {ago(key.createdAt)}</div>
              </div>
              <button
                type="button"
                class="icon-btn"
                aria-label={`Remove ${key.name}`}
                onClick={() =>
                  recent.run(async () => {
                    await api(`/api/me/passkeys/${key.id}`, { method: "DELETE" });
                    await keys.refresh();
                  })
                }
              >
                <Trash2 />
              </button>
            </div>
          ))}
        </div>
      )}
      <button type="button" class="btn ink" onClick={add}>
        <Plus />
        Add a passkey
      </button>
      <p class="fn">Works on {others}.</p>
      {recent.error.value && <p class="err">{recent.error.value}</p>}
      <span class="gh">Password</span>
      <div class="group">
        <button
          type="button"
          class="li btn-li"
          onClick={() => {
            changing.value = true;
          }}
        >
          <div class="grow">
            <div class="tt">{keys.data.value?.passwordSetAt ? "Change password" : "Set a password"}</div>
            {keys.data.value?.passwordSetAt && <div class="ss">Set {ago(keys.data.value.passwordSetAt)}</div>}
          </div>
          <ChevronRight class="chev" />
        </button>
      </div>
      <span class="gh">Signed in on</span>
      <div class="group">
        {sessions.data.value?.map((row) => (
          <div class="li" key={row.id}>
            <Laptop />
            <div class="grow">
              <div class="tt">{row.name}</div>
              <div class="ss">
                {row.kind === "connector" && "Connector, "}
                {row.current ? "This browser" : row.lastSeenAt ? ago(row.lastSeenAt) : "Not used yet"}
              </div>
            </div>
            {!row.current && (
              <button
                type="button"
                class="btn soft fit"
                onClick={async () => {
                  await api(`/api/me/sessions/${row.id}`, { method: "DELETE" });
                  await sessions.refresh();
                }}
              >
                End
              </button>
            )}
          </div>
        ))}
      </div>
      {changing.value && (
        <Sheet
          title="Change password"
          onClose={() => {
            changing.value = false;
          }}
        >
          <label class="gh" for="new-password">
            New password
          </label>
          <input
            id="new-password"
            class="field"
            type="password"
            autocomplete="new-password"
            minLength={12}
            value={password.value}
            onInput={(e) => {
              password.value = e.currentTarget.value;
            }}
          />
          <p class="fn">At least 12 characters. Your other sign-ins end when you save.</p>
          <button
            type="button"
            class="btn ink"
            disabled={password.value.length < 12}
            onClick={() =>
              recent.run(async () => {
                await post("/api/me/password", { password: password.value });
                changing.value = false;
                password.value = "";
                await Promise.all([keys.refresh(), sessions.refresh()]);
              })
            }
          >
            Save password
          </button>
        </Sheet>
      )}
      {recent.sheet}
    </Frame>
  );
}

type PersonRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  password: boolean;
  passkeys: number;
  shares: { title: string; permission: string }[];
  teams: { slug: string; name: string; role: string }[];
  projects: { slug: string; name: string; permission: keyof typeof LEVELS }[];
};
type InviteRow = { id: string; email: string; role: string; expiresAt: string };
type PeopleList = { people: PersonRow[]; invites: InviteRow[] };

const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});
const roleName = (role: string) => `${role[0]?.toUpperCase()}${role.slice(1)}`;

function People() {
  const tab = useSignal<"org" | "outside">("org");
  const list = usePoll<PeopleList>(`/api/people${tab.value === "outside" ? "?kind=outside" : ""}`, 60_000);
  const inviting = useSignal(false);
  const selected = useSignal<PersonRow | null>(null);
  const email = useSignal("");
  const role = useSignal("member");
  const link = useSignal<string | null>(null);
  const error = useSignal<string | null>(null);
  const teams = usePoll<TeamList>("/api/teams", 60_000);
  const joining = useSignal<string[]>([]);

  async function invite() {
    error.value = null;
    try {
      const { url } = await post<{ url: string }>("/api/invites", {
        email: email.value,
        role: role.value,
        teamIds: joining.value,
      });
      link.value = url;
      copy(url);
      await list.refresh();
    } catch (failure) {
      error.value = message(failure);
    }
  }
  async function act(work: () => Promise<unknown>) {
    error.value = null;
    try {
      await work();
      await list.refresh();
    } catch (failure) {
      error.value = message(failure);
    }
  }

  const person = selected.value;
  return (
    <Frame title="People">
      <button
        type="button"
        class="btn ink"
        onClick={() => {
          inviting.value = true;
          link.value = null;
          email.value = "";
          joining.value = [];
        }}
      >
        <Plus />
        Invite
      </button>
      <div class="seg">
        <button
          type="button"
          aria-pressed={tab.value === "org"}
          onClick={() => {
            tab.value = "org";
          }}
        >
          Organization
        </button>
        <button
          type="button"
          aria-pressed={tab.value === "outside"}
          onClick={() => {
            tab.value = "outside";
          }}
        >
          Outside
        </button>
      </div>
      <div class="group">
        {list.data.value?.people.map((row) => (
          <button
            type="button"
            class="li btn-li"
            key={row.id}
            onClick={() => {
              selected.value = row;
            }}
          >
            <span class={`av${row.id === me.value?.id ? " you" : ""}`}>{row.name[0]}</span>
            <div class="grow">
              <div class="tt">{row.name}</div>
              <div class="ss">
                {tab.value === "outside"
                  ? row.shares.map((share) => share.title).join(", ")
                  : `${roleName(row.role)}, ${row.email}`}
              </div>
            </div>
          </button>
        ))}
      </div>
      {(list.data.value?.invites.length ?? 0) > 0 && <span class="gh">Invited</span>}
      {(list.data.value?.invites.length ?? 0) > 0 && (
        <div class="group">
          {list.data.value?.invites.map((row) => (
            <div class="li" key={row.id}>
              <div class="grow">
                <div class="tt">{row.email}</div>
                <div class="ss">
                  {roleName(row.role)}, expires {ago(row.expiresAt).replace(" ago", "")}
                </div>
              </div>
              <button
                type="button"
                class="icon-btn"
                aria-label={`Copy a new link for ${row.email}`}
                onClick={() =>
                  act(async () => {
                    const { url } = await post<{ url: string }>(`/api/invites/${row.id}/link`);
                    copy(url);
                    link.value = url;
                  })
                }
              >
                <Copy />
              </button>
              <button
                type="button"
                class="icon-btn"
                aria-label={`Revoke the invite for ${row.email}`}
                onClick={() => act(() => api(`/api/invites/${row.id}`, { method: "DELETE" }))}
              >
                <X />
              </button>
            </div>
          ))}
        </div>
      )}
      <p class="fn">
        Invites aren't emailed. Copying a pending invite makes a new link; the old one stops working.
      </p>
      {link.value && !inviting.value && (
        <p class="fn mono" style="overflow-wrap:anywhere">
          {link.value}
        </p>
      )}
      {error.value && !inviting.value && !person && <p class="err">{error.value}</p>}
      {inviting.value && (
        <Sheet
          title={`Invite to ${meta.value?.orgName}`}
          onClose={() => {
            inviting.value = false;
          }}
        >
          <label class="gh" for="invite-email">
            Email
          </label>
          <input
            id="invite-email"
            class="field"
            type="email"
            value={email.value}
            onInput={(e) => {
              email.value = e.currentTarget.value;
            }}
          />
          <span class="gh">Role</span>
          <div class="seg">
            {["member", "reviewer", "admin"].map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={role.value === value}
                onClick={() => {
                  role.value = value;
                }}
              >
                {roleName(value)}
              </button>
            ))}
          </div>
          <p class="fn">
            {role.value === "reviewer"
              ? "Reviewers read and comment. They can't publish."
              : role.value === "admin"
                ? "Admins manage people and settings."
                : "Members publish, comment and share their own work."}
          </p>
          {(teams.data.value?.teams.length ?? 0) > 0 && <span class="gh">Teams</span>}
          {(teams.data.value?.teams.length ?? 0) > 0 && (
            <div class="group">
              {teams.data.value?.teams.map((team) => {
                const on = joining.value.includes(team.id);
                return (
                  <button
                    type="button"
                    class="li btn-li"
                    key={team.id}
                    aria-pressed={on}
                    onClick={() => {
                      joining.value = on
                        ? joining.value.filter((id) => id !== team.id)
                        : [...joining.value, team.id];
                    }}
                  >
                    <div class="grow">
                      <div class="tt">{team.name}</div>
                    </div>
                    {on && <Check />}
                  </button>
                );
              })}
            </div>
          )}
          {link.value && (
            <div class="card" style="padding:10px 14px">
              <div class="mono" style="font-size:14px;overflow-wrap:anywhere">
                {link.value}
              </div>
            </div>
          )}
          {error.value && <p class="err">{error.value}</p>}
          <button type="button" class="btn ink" disabled={!email.value} onClick={invite}>
            <Copy />
            Copy invite link
          </button>
          <p class="fn center">Send it yourself in Messages or Slack. It works once and expires in 7 days.</p>
        </Sheet>
      )}
      {person && (
        <Sheet
          title={person.name}
          onClose={() => {
            selected.value = null;
          }}
        >
          <div class="group">
            <div class="li">
              <div class="grow">
                <div class="tt">Role</div>
              </div>
              <span class="ss">{roleName(person.role)}</span>
            </div>
            <div class="li">
              <div class="grow">
                <div class="tt">Sign-in</div>
              </div>
              <span class="ss">
                {[person.password ? "Password" : null, person.passkeys ? "Passkey" : null]
                  .filter(Boolean)
                  .join(" and ") || "None yet"}
              </span>
            </div>
            {person.teams.length > 0 && (
              <div class="li">
                <div class="grow">
                  <div class="tt">Teams</div>
                </div>
                <span class="ss">
                  {person.teams.map((team, i) => (
                    <span key={team.slug}>
                      {i > 0 && ", "}
                      <a href={`/settings/teams/${team.slug}`}>{team.name}</a>
                    </span>
                  ))}
                </span>
              </div>
            )}
            {person.projects.length > 0 && (
              <div class="li">
                <div class="grow">
                  <div class="tt">Projects</div>
                </div>
                <span class="ss">
                  {person.projects.map((project, i) => (
                    <span key={project.slug}>
                      {i > 0 && ", "}
                      <a href={`/${project.slug}`}>{project.name}</a>
                    </span>
                  ))}
                </span>
              </div>
            )}
          </div>
          {person.role !== "outside" && (
            <div class="seg">
              {["member", "reviewer", "admin"].map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={person.role === value}
                  onClick={() =>
                    act(async () => {
                      await api(`/api/people/${person.id}`, { method: "PATCH", json: { role: value } });
                      selected.value = { ...person, role: value };
                    })
                  }
                >
                  {roleName(value)}
                </button>
              ))}
            </div>
          )}
          {link.value && (
            <p class="fn mono" style="overflow-wrap:anywhere">
              {link.value}
            </p>
          )}
          <button
            type="button"
            class="btn ink"
            onClick={() =>
              act(async () => {
                const { url } = await post<{ url: string }>(`/api/people/${person.id}/reset-link`);
                copy(url);
                link.value = url;
              })
            }
          >
            <Copy />
            Copy reset link
          </button>
          <p class="fn">
            Works once, for 1 hour. {person.name}'s other sign-ins end when the password changes.
          </p>
          {error.value && <p class="err">{error.value}</p>}
          <button
            type="button"
            class="btn soft"
            style="color:var(--warn-word)"
            onClick={() =>
              act(async () => {
                if (!confirm(`Remove ${person.name} from ${meta.value?.orgName}?`)) return;
                await api(`/api/people/${person.id}`, { method: "DELETE" });
                selected.value = null;
              })
            }
          >
            Remove {person.name} from {meta.value?.orgName}
          </button>
        </Sheet>
      )}
    </Frame>
  );
}

type TeamRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  members: number;
  role: "lead" | "member" | null;
};
type TeamList = { teams: TeamRow[] };
type TeamPage = {
  team: TeamRow;
  members: { id: string; name: string; email: string; role: "lead" | "member"; orgRole: string }[];
  shared: { id: string; project: string; slug: string; title: string; level: keyof typeof LEVELS }[];
  permissions: { manage: boolean; members: boolean };
};

function Teams() {
  const list = usePoll<TeamList>("/api/teams", 60_000);
  const creating = useSignal(false);
  const name = useSignal("");
  const about = useSignal("");
  const error = useSignal<string | null>(null);
  const { route } = useLocation();
  async function create() {
    error.value = null;
    try {
      const { team } = await post<{ team: TeamRow }>("/api/teams", {
        name: name.value,
        description: about.value || null,
      });
      route(`/settings/teams/${team.slug}`);
    } catch (failure) {
      error.value = message(failure);
    }
  }
  const rows = list.data.value?.teams ?? [];
  return (
    <Frame title="Teams">
      {ADMIN() && (
        <button
          type="button"
          class="btn ink"
          onClick={() => {
            creating.value = true;
            name.value = "";
            about.value = "";
          }}
        >
          <Plus />
          New team
        </button>
      )}
      {rows.length > 0 ? (
        <div class="group">
          {rows.map((team) => (
            <a class="li" href={`/settings/teams/${team.slug}`} key={team.id}>
              <Users />
              <div class="grow">
                <div class="tt">{team.name}</div>
                <div class="ss">
                  {plural(team.members, "person", "people")}
                  {team.role === "lead" ? ", you lead it" : team.role ? ", you're in it" : ""}
                </div>
              </div>
              <ChevronRight class="chev" />
            </a>
          ))}
        </div>
      ) : (
        list.data.value && (
          <div class="empty">
            No teams yet. A team shares work in one step, and anyone added later gets the same access.
          </div>
        )
      )}
      {creating.value && (
        <Sheet
          title="New team"
          onClose={() => {
            creating.value = false;
          }}
        >
          <label class="gh" for="team-name">
            Name
          </label>
          <input
            id="team-name"
            class="field"
            maxLength={60}
            value={name.value}
            onInput={(e) => {
              name.value = e.currentTarget.value;
            }}
          />
          <label class="gh" for="team-about">
            What it's for
          </label>
          <input
            id="team-about"
            class="field"
            maxLength={280}
            value={about.value}
            onInput={(e) => {
              about.value = e.currentTarget.value;
            }}
          />
          {error.value && <p class="err">{error.value}</p>}
          <button type="button" class="btn ink" disabled={!name.value.trim()} onClick={create}>
            Create team
          </button>
        </Sheet>
      )}
    </Frame>
  );
}

function TeamDetail({ slug }: { slug: string }) {
  const { route } = useLocation();
  const page = usePoll<TeamPage>(`/api/teams/${encodeURIComponent(slug)}`, 60_000);
  const error = useSignal<string | null>(null);
  const renaming = useSignal<string | null>(null);
  const act = async (work: () => Promise<unknown>) => {
    error.value = null;
    try {
      await work();
      await page.refresh();
    } catch (failure) {
      error.value = message(failure);
    }
  };
  const body = page.data.value;
  if (page.error.value?.status === 404) return <Frame title="No such team">{null}</Frame>;
  if (!body) return null;
  const path = `/api/teams/${encodeURIComponent(slug)}`;
  const { team, members, shared, permissions } = body;
  return (
    <Frame title={team.name} back="/settings/teams" backLabel="Teams">
      {team.description && <p class="sub">{team.description}</p>}
      {permissions.members && (
        <Picker
          teams={false}
          placeholder="Add a person"
          skip={members.map((member) => member.id)}
          onPick={(choice) =>
            act(() => api(`${path}/members/${choice.id}`, { method: "PUT", json: { role: "member" } }))
          }
        />
      )}
      <span class="gh">{plural(team.members, "person", "people")}</span>
      {members.length > 0 && (
        <div class="group">
          {members.map((member) => (
            <div class="li" key={member.id}>
              <span class={`av${member.id === me.value?.id ? " you" : ""}`}>{member.name[0]}</span>
              <div class="grow">
                <div class="tt">{member.name}</div>
                <div class="ss">
                  {member.email}
                  {["outside", "reviewer"].includes(member.orgRole) && `, ${roleName(member.orgRole)}`}
                </div>
              </div>
              {permissions.members && !["outside", "reviewer"].includes(member.orgRole) ? (
                <select
                  class="level"
                  aria-label={`Role for ${member.name}`}
                  value={member.role}
                  onChange={(e) => {
                    const role = e.currentTarget.value;
                    act(() => api(`${path}/members/${member.id}`, { method: "PUT", json: { role } }));
                  }}
                >
                  <option value="member">Member</option>
                  <option value="lead">Lead</option>
                </select>
              ) : (
                member.role === "lead" && <span class="word">Lead</span>
              )}
              {permissions.members && (
                <button
                  type="button"
                  class="icon-btn"
                  aria-label={`Remove ${member.name}`}
                  onClick={() => act(() => api(`${path}/members/${member.id}`, { method: "DELETE" }))}
                >
                  <X />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <a class="fn" href={`/projects?team=${team.slug}`}>
        See its projects
      </a>
      <p class="fn">
        Anyone added here gets what the team has. Reviewers and outside people stop at commenting.
      </p>
      {shared.length > 0 && <span class="gh">Shared with this team</span>}
      {shared.length > 0 && (
        <div class="group">
          {shared.map((row) => (
            <a class="li" href={`/${row.project}/${row.slug}`} key={row.id}>
              <div class="grow">
                <div class="tt">{row.title}</div>
                <div class="ss">{LEVELS[row.level]}</div>
              </div>
              <ChevronRight class="chev" />
            </a>
          ))}
        </div>
      )}
      {error.value && <p class="err">{error.value}</p>}
      {permissions.manage && (
        <>
          <button
            type="button"
            class="btn soft"
            onClick={() => {
              renaming.value = team.name;
            }}
          >
            Rename {team.name}
          </button>
          <button
            type="button"
            class="btn soft"
            style="color:var(--warn-word)"
            onClick={() =>
              act(async () => {
                if (!confirm(`Delete ${team.name}? Everyone in it loses what the team was given.`)) return;
                await api(path, { method: "DELETE" });
                route("/settings/teams");
              })
            }
          >
            Delete {team.name}
          </button>
        </>
      )}
      {renaming.value !== null && (
        <Sheet
          title="Rename"
          onClose={() => {
            renaming.value = null;
          }}
        >
          <label class="gh" for="team-rename">
            Name
          </label>
          <input
            id="team-rename"
            class="field"
            maxLength={60}
            value={renaming.value}
            onInput={(e) => {
              renaming.value = e.currentTarget.value;
            }}
          />
          <button
            type="button"
            class="btn ink"
            disabled={!renaming.value.trim()}
            onClick={() =>
              act(async () => {
                await api(path, { method: "PATCH", json: { name: renaming.value } });
                renaming.value = null;
              })
            }
          >
            Save
          </button>
        </Sheet>
      )}
    </Frame>
  );
}

type Org = {
  newVersion: string | null;
  name: string;
  settings: {
    defaultVisibility: "me" | "org";
    linkSharing: boolean;
    defaultProjectAccess: "org" | "restricted";
  };
  domains: { home: string; publicUrl: string; moreUrls: string[]; contentUrl: string | null };
};

function Domains() {
  const { data } = usePoll<Org>("/api/org", 60_000);
  const d = data.value?.domains;
  if (!d) return null;
  const primary = new URL(d.publicUrl).hostname;
  const others = d.moreUrls.map((url) => new URL(url).hostname).filter((host) => host !== d.home);
  return (
    <Frame title="Domains">
      <span class="gh">Viewer</span>
      <div class="group">
        <div class="li">
          <Globe />
          <div class="grow">
            <div class="tt" style="overflow-wrap:anywhere">
              {primary}
            </div>
            <div class="ss">Used in links you copy</div>
          </div>
          <span class="word ok">Primary</span>
        </div>
        {others.map((host) => (
          <div class="li" key={host}>
            <Globe />
            <div class="grow">
              <div class="tt" style="overflow-wrap:anywhere">
                {host}
              </div>
            </div>
          </div>
        ))}
        <div class="li">
          <KeyRound />
          <div class="grow">
            <div class="tt" style="overflow-wrap:anywhere">
              {d.home}
            </div>
            <div class="ss">Home of your passkeys. Keep it attached</div>
          </div>
        </div>
      </div>
      <span class="gh">Live previews</span>
      <div class="group">
        <div class="li">
          <Lock />
          <div class="grow">
            <div class="tt" style="overflow-wrap:anywhere">
              {d.contentUrl ? new URL(d.contentUrl).hostname : "Not set up"}
            </div>
            <div class="ss">Where interactive frames run, walled off from your account</div>
          </div>
        </div>
      </div>
      <p class="fn">
        Passkeys made on the home domain also work on your other domains in Safari on iOS 18+, Chrome 128+ and
        Firefox 152+. Older browsers use the password.
      </p>
    </Frame>
  );
}

type BrandInfo = { name: string; theme: { accent?: string } };
type Proposal = {
  id: string;
  name: string;
  brand: BrandInfo;
  sample: { project: string; slug: string } | null;
  proposedBy: string;
  agent: string | null;
  appliedAt: string | null;
};

function BrandSettings() {
  const current = usePoll<{ brand: BrandInfo | null }>("/api/brand", 60_000);
  const proposals = usePoll<Proposal[]>("/api/brand/proposals", 60_000);
  const error = useSignal<string | null>(null);
  const act = async (path: string, method: "POST" | "DELETE") => {
    try {
      await api(path, { method });
      await Promise.all([current.refresh(), proposals.refresh()]);
    } catch (failure) {
      error.value = message(failure);
    }
  };
  const brand = current.data.value?.brand;
  const list = proposals.data.value ?? [];
  return (
    <Frame title="Brand">
      <p class="fn">
        {brand
          ? `Templates use ${brand.name}. A project's own theme still wins.`
          : "Templates use their own look. An agent can propose a brand with artifacts brand propose."}
      </p>
      {error.value && <p class="fn">{error.value}</p>}
      {brand && (
        <button type="button" class="btn" onClick={() => act("/api/brand", "DELETE")}>
          Go back to the default
        </button>
      )}
      {list.length > 0 && <span class="gh">Proposed</span>}
      <div class="group">
        {list.map((row) => (
          <div class="li" key={row.id}>
            <span
              aria-hidden="true"
              style={`width:22px;height:22px;border-radius:50%;flex:none;background:${/^#[0-9a-fA-F]{6}$/.test(row.brand.theme.accent ?? "") ? row.brand.theme.accent : "transparent"}`}
            />
            <div class="grow">
              <div class="tt">{row.name}</div>
              <div class="ss">
                {row.agent ? `${row.agent} for ${row.proposedBy}` : row.proposedBy}
                {row.sample && (
                  <>
                    {", "}
                    <a href={`/${row.sample.project}/${row.sample.slug}`}>see the sample</a>
                  </>
                )}
              </div>
            </div>
            {row.appliedAt ? (
              <span class="word ok">Applied</span>
            ) : (
              <button
                type="button"
                class="btn"
                onClick={() => act(`/api/brand/proposals/${row.id}/apply`, "POST")}
              >
                Apply
              </button>
            )}
          </div>
        ))}
      </div>
    </Frame>
  );
}

function OrgSettings() {
  const org = usePoll<Org>("/api/org", 60_000);
  const name = useSignal<string | null>(null);
  const error = useSignal<string | null>(null);
  const body = org.data.value;
  if (!body) return null;
  const save = async (json: unknown) => {
    try {
      await api("/api/org", { method: "PATCH", json });
      await org.refresh();
    } catch (failure) {
      error.value = message(failure);
    }
  };
  return (
    <Frame title="Organization">
      {body.newVersion && (
        <p class="fn">
          Version {body.newVersion} is out. Run <code>artifacts upgrade --server</code> to move to it.
        </p>
      )}
      <label class="gh" for="org-name">
        Name
      </label>
      <input
        id="org-name"
        class="field"
        value={name.value ?? body.name}
        onInput={(e) => {
          name.value = e.currentTarget.value;
        }}
        onBlur={() => {
          if (name.value && name.value !== body.name) save({ name: name.value });
        }}
      />
      <span class="gh">New artifacts are visible to</span>
      <div class="seg">
        {(["org", "me"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={body.settings.defaultVisibility === value}
            onClick={() => save({ settings: { defaultVisibility: value } })}
          >
            {value === "org" ? "Organization" : "Only me"}
          </button>
        ))}
      </div>
      <span class="gh">New projects are visible to</span>
      <div class="seg">
        {(["org", "restricted"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={body.settings.defaultProjectAccess === value}
            onClick={() => save({ settings: { defaultProjectAccess: value } })}
          >
            {value === "org" ? "Organization" : "Only people added"}
          </button>
        ))}
      </div>
      <span class="gh">Share links</span>
      <div class="seg">
        {[true, false].map((value) => (
          <button
            type="button"
            key={String(value)}
            aria-pressed={body.settings.linkSharing === value}
            onClick={() => save({ settings: { linkSharing: value } })}
          >
            {value ? "On" : "Off"}
          </button>
        ))}
      </div>
      {error.value && <p class="err">{error.value}</p>}
    </Frame>
  );
}

type TokenRow = { id: string; name: string; scopes: string[]; lastUsedAt: string | null };

function Tokens() {
  const list = usePoll<TokenRow[]>("/api/tokens", 60_000);
  const recent = useRecent();
  const name = useSignal("");
  const made = useSignal<string | null>(null);
  const projects = usePoll<{ id: string; name: string; restricted?: boolean }[]>("/api/projects", 60_000);
  const chosen = useSignal<string[]>([]);
  return (
    <Frame title="Tokens">
      <p class="sub">
        For CI and headless agents. A token can publish and read, but never resolve, approve or purge.
      </p>
      <label class="gh" for="token-name">
        Name
      </label>
      <input
        id="token-name"
        class="field"
        value={name.value}
        onInput={(e) => {
          name.value = e.currentTarget.value;
        }}
      />
      <span class="gh">Projects</span>
      <div class="group">
        <button
          type="button"
          class="li btn-li"
          onClick={() => {
            chosen.value = [];
          }}
        >
          <div class="grow">
            <div class="tt">Every open project</div>
            <div class="ss">And any it creates. A restricted project has to be chosen below.</div>
          </div>
          {chosen.value.length === 0 && <Check />}
        </button>
        {projects.data.value?.map((project) => {
          const on = chosen.value.includes(project.id);
          return (
            <button
              type="button"
              class="li btn-li"
              key={project.id}
              aria-pressed={on}
              onClick={() => {
                chosen.value = on
                  ? chosen.value.filter((id) => id !== project.id)
                  : [...chosen.value, project.id];
              }}
            >
              <div class="grow">
                <div class="tt">{project.name}</div>
                {project.restricted && <div class="ss">Restricted</div>}
              </div>
              {on && <Check />}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        class="btn ink"
        disabled={!name.value}
        onClick={() =>
          recent.run(async () => {
            const { token } = await post<{ token: string }>("/api/tokens", {
              name: name.value,
              scopes: ["publish", "read", "org"],
              ...(chosen.value.length > 0 ? { projectIds: chosen.value } : {}),
            });
            made.value = token;
            name.value = "";
            chosen.value = [];
            await list.refresh();
          })
        }
      >
        Create token
      </button>
      {made.value && (
        <div class="card" style="padding:12px 14px">
          <div class="ss">Copy it now. It's only shown once.</div>
          <div class="mono" style="font-size:14px;overflow-wrap:anywhere">
            {made.value}
          </div>
        </div>
      )}
      {recent.error.value && <p class="err">{recent.error.value}</p>}
      {(list.data.value?.length ?? 0) > 0 && (
        <div class="group">
          {list.data.value?.map((row) => (
            <div class="li" key={row.id}>
              <div class="grow">
                <div class="tt">{row.name}</div>
                <div class="ss">{row.lastUsedAt ? `Used ${ago(row.lastUsedAt)}` : "Not used yet"}</div>
              </div>
              <button
                type="button"
                class="btn soft fit"
                onClick={async () => {
                  await api(`/api/tokens/${row.id}`, { method: "DELETE" });
                  await list.refresh();
                }}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
      {recent.sheet}
    </Frame>
  );
}

function Notifications() {
  const on = useSignal<boolean | null>(null);
  const error = useSignal<string | null>(null);
  useEffect(() => {
    currentSubscription().then((subscription) => {
      on.value = subscription !== null;
    });
  }, []);
  const change = async (work: () => Promise<unknown>) => {
    try {
      await work();
      on.value = (await currentSubscription()) !== null;
    } catch (failure) {
      error.value = message(failure);
    }
  };
  return (
    <main class="main">
      <a class="back" href="/settings">
        <ChevronLeft />
        Settings
      </a>
      <h1 class="h1">Notifications</h1>
      {needsInstall() ? (
        <div class="empty">
          iPhone only sends web notifications to apps on your Home Screen. Add this site there first.
        </div>
      ) : !canPush() ? (
        <div class="empty">This browser can't receive notifications.</div>
      ) : (
        on.value !== null && (
          <>
            <div class="group">
              <div class="li">
                <div class="grow">
                  <div class="tt">{on.value ? "On for this device" : "Off for this device"}</div>
                  <div class="ss">When an agent publishes or someone replies, and a daily summary</div>
                </div>
              </div>
            </div>
            {error.value && <p class="err">{error.value}</p>}
            <button
              type="button"
              class="btn soft"
              onClick={() => change(on.value ? turnOffNotifications : turnOnNotifications)}
            >
              {on.value ? "Turn off" : "Turn on"}
            </button>
          </>
        )
      )}
    </main>
  );
}

const PAGES: Record<string, () => preact.JSX.Element | null> = {
  "sign-in": SignIn,
  notifications: Notifications,
  people: People,
  teams: Teams,
  domains: Domains,
  org: OrgSettings,
  brand: BrandSettings,
  tokens: Tokens,
};

export function Settings() {
  const { params } = useRoute();
  const Page = PAGES[params.section ?? ""] ?? Index;
  return <SignedIn>{params.slug ? <TeamDetail slug={params.slug} /> : <Page />}</SignedIn>;
}
