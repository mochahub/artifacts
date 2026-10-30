import { useSignal } from "@preact/signals";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Globe,
  KeyRound,
  Laptop,
  Lock,
  Plus,
  Trash2,
  X,
} from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useRoute } from "preact-iso";
import { ApiFailure, api, post } from "../api.ts";
import { ReauthSheet } from "../components/reauth.tsx";
import { Sheet } from "../components/sheets.tsx";
import { ago } from "../format.ts";
import { addPasskey, passkeyName } from "../passkey.ts";
import { usePoll } from "../poll.ts";
import { me, meta } from "../session.ts";
import { SignedIn } from "./guard.tsx";

const ADMIN = () => me.value?.role === "owner" || me.value?.role === "admin";
const message = (failure: unknown) =>
  failure instanceof ApiFailure ? failure.message : "Something went wrong.";

function Frame({
  title,
  back = "/settings",
  children,
}: {
  title: string;
  back?: string;
  children: ComponentChildren;
}) {
  return (
    <main class="main">
      <a class="back" href={back}>
        <ChevronLeft />
        Settings
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
    ...(admin
      ? [
          ["/settings/people", "People", "Members, outside people and invites"],
          ["/settings/tokens", "Tokens", "For CI and headless agents"],
          ["/settings/domains", "Domains", "Where this deployment answers"],
          ["/settings/org", "Organization", "Name, defaults and link sharing"],
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
          await post("/api/auth/logout");
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
  kind: "session" | "cli";
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
              <div class="tt">{row.kind === "cli" ? row.name : row.name}</div>
              <div class="ss">
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

  async function invite() {
    error.value = null;
    try {
      const { url } = await post<{ url: string }>("/api/invites", { email: email.value, role: role.value });
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

type Org = {
  name: string;
  settings: { defaultVisibility: "me" | "org"; linkSharing: boolean };
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
      <button
        type="button"
        class="btn ink"
        disabled={!name.value}
        onClick={() =>
          recent.run(async () => {
            const { token } = await post<{ token: string }>("/api/tokens", {
              name: name.value,
              scopes: ["publish", "read", "org"],
            });
            made.value = token;
            name.value = "";
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

const PAGES: Record<string, () => preact.JSX.Element | null> = {
  "sign-in": SignIn,
  people: People,
  domains: Domains,
  org: OrgSettings,
  tokens: Tokens,
};

export function Settings() {
  const { params } = useRoute();
  const Page = PAGES[params.section ?? ""] ?? Index;
  return (
    <SignedIn>
      <Page />
    </SignedIn>
  );
}
