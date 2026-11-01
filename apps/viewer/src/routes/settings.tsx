import { BRAND_PROMPT } from "@artifacts/schema/brand-prompt";
import {
  contrast,
  FONT_STACKS,
  type Neutrals,
  type ThemeValues,
  themeStyle,
} from "@artifacts/schema/theme-css";
import { useSignal } from "@preact/signals";
import {
  ChevronDown,
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
import { useEffect } from "preact/hooks";
import { useRoute } from "preact-iso";
import { ApiFailure, api, post } from "../api.ts";
import { ReauthSheet } from "../components/reauth.tsx";
import { Sheet } from "../components/sheets.tsx";
import { ago } from "../format.ts";
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
    ["/settings/notifications", "Notifications", "On this device"],
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
  newVersion: string | null;
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

type BrandTheme = Omit<ThemeValues, "mode">;
type BrandInfo = { name: string; theme: BrandTheme; fonts: { family: string }[] };
type Proposal = {
  id: string;
  name: string;
  brand: BrandInfo;
  sample: { project: string; slug: string } | null;
  proposedBy: string;
  agent: string | null;
  current: boolean;
};

const CORNERS: [string, number | undefined][] = [
  ["Template", undefined],
  ["Tight", 4],
  ["Soft", 10],
  ["Round", 20],
];
const NEUTRALS: [keyof Neutrals, string, string][] = [
  ["bg", "Background", "#f5f6f8"],
  ["card", "Cards", "#ffffff"],
  ["text", "Text", "#121418"],
  ["muted", "Quiet text", "#5e6470"],
  ["line", "Lines", "#e4e6ea"],
];
const fallback = (key: keyof Neutrals) => NEUTRALS.find(([name]) => name === key)?.[2] as string;
const HEX = /^#[0-9a-fA-F]{6}$/;
/** Pasting from a brand guide often leaves the # behind. */
const asHex = (value: string) => {
  const text = value.trim();
  return !text || text.startsWith("#") ? text : `#${text}`;
};
/** Safari's property is a boolean, and any string turns it on. The types only allow a string. */
const OFF_AUTOCORRECT: object = { autocorrect: false };
const title = (word: string) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

function ColorRow({
  label,
  value,
  shown,
  onChange,
}: {
  label: string;
  value: string;
  shown: string;
  onChange: (value: string) => void;
}) {
  return (
    <div class="li">
      <span class="grow tt">{label}</span>
      <input
        class="hex"
        aria-label={`${label}, as a hex colour`}
        autocapitalize="off"
        {...OFF_AUTOCORRECT}
        spellcheck={false}
        placeholder="Not set"
        value={value}
        onInput={(e) => onChange(asHex(e.currentTarget.value))}
      />
      <input
        class="swatch"
        type="color"
        aria-label={`Pick ${label.toLowerCase()}`}
        value={HEX.test(value) ? value : shown}
        onInput={(e) => onChange(e.currentTarget.value)}
      />
    </div>
  );
}

function FontField({
  id,
  label,
  value,
  own,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  own: string[];
  onChange: (value: string) => void;
}) {
  return (
    <>
      <label class="gh" for={id}>
        {label}
      </label>
      <div class="select">
        <select id={id} class="field" value={value} onChange={(e) => onChange(e.currentTarget.value)}>
          <option value="">Template's own</option>
          {[...Object.keys(FONT_STACKS), ...own].map((name) => (
            <option key={name} value={name}>
              {own.includes(name) ? name : title(name)}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden="true" />
      </div>
    </>
  );
}

function BrandForm({
  brand,
  orgName,
  onSaved,
}: {
  brand: BrandInfo | null;
  orgName: string;
  onSaved: () => Promise<void>;
}) {
  const name = useSignal(brand?.name ?? orgName);
  const accent = useSignal(brand?.theme.accent ?? "");
  const display = useSignal(brand?.theme.display ?? "");
  const font = useSignal(brand?.theme.font ?? "");
  const radius = useSignal(brand?.theme.radius);
  const neutrals = useSignal<Neutrals>(brand?.theme.neutrals ?? {});
  const dirty = useSignal(brand === null);
  const own = brand?.fonts.map((row) => row.family).filter(unique) ?? [];
  const error = useSignal<string | null>(null);
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      dirty.value = true;
    };
  const colors = [accent.value, ...Object.values(neutrals.value)].filter(Boolean) as string[];
  const valid = colors.every((color) => HEX.test(color));
  // What the form can't show, such as dark colours from an agent, stays as it was.
  const theme: BrandTheme = {
    ...(brand && { scale: brand.theme.scale, neutralsDark: brand.theme.neutralsDark }),
    ...(accent.value && { accent: accent.value }),
    ...(display.value && { display: display.value }),
    ...(font.value && { font: font.value }),
    ...(radius.value !== undefined && { radius: radius.value }),
    ...(colors.length > (accent.value ? 1 : 0) && {
      neutrals: Object.fromEntries(Object.entries(neutrals.value).filter(([, color]) => color)),
    }),
  };
  const { text, bg } = neutrals.value;
  const shade = (key: "text" | "bg") => {
    const color = neutrals.value[key];
    return color && HEX.test(color) ? color : fallback(key);
  };
  const ratio = text || bg ? contrast(shade("text"), shade("bg")) : 21;
  const save = async () => {
    error.value = null;
    try {
      await api("/api/brand", { method: "PUT", json: { name: name.value.trim(), theme } });
      dirty.value = false;
      await onSaved();
    } catch (failure) {
      error.value = message(failure);
    }
  };
  return (
    <>
      <figure class="specimen" style={themeStyle(theme)} aria-label="Preview">
        <div class="specimen-card">
          <h2>{name.value.trim() || "Your brand"}</h2>
          <p>This is how your templates will read.</p>
          <small>Dates, captions and other quiet text.</small>
          <hr />
          <span class="specimen-action">Primary action</span>
        </div>
      </figure>
      <label class="gh" for="brand-name">
        Name
      </label>
      <input
        id="brand-name"
        class="field"
        maxLength={80}
        value={name.value}
        onInput={(e) => edit((value: string) => (name.value = value))(e.currentTarget.value)}
      />
      <span class="gh">Colour</span>
      <div class="group">
        <ColorRow
          label="Accent"
          value={accent.value}
          shown="#0a84ff"
          onChange={edit((value: string) => (accent.value = value))}
        />
      </div>
      <FontField
        id="brand-display"
        label="Headings"
        value={display.value}
        own={own}
        onChange={edit((value: string) => (display.value = value))}
      />
      <FontField
        id="brand-font"
        label="Body text"
        value={font.value}
        own={own}
        onChange={edit((value: string) => (font.value = value))}
      />
      <span class="gh">Corners</span>
      <div class="seg">
        {CORNERS.map(([label, value]) => (
          <button
            type="button"
            key={label}
            aria-pressed={radius.value === value}
            onClick={() => edit((next: number | undefined) => (radius.value = next))(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <details class="more" open={Object.keys(neutrals.value).length > 0}>
        <summary>
          More colours
          <ChevronRight aria-hidden="true" />
        </summary>
        <div class="group">
          {NEUTRALS.map(([key, label, shown]) => (
            <ColorRow
              key={key}
              label={label}
              value={neutrals.value[key] ?? ""}
              shown={shown}
              onChange={edit((value: string) => {
                neutrals.value = { ...neutrals.value, [key]: value };
              })}
            />
          ))}
        </div>
      </details>
      {!valid && <p class="err">Use a colour like #d2452d.</p>}
      {ratio < 4.5 && <p class="err">Text will be hard to read on this background.</p>}
      {error.value && <p class="err">{error.value}</p>}
      <button
        type="button"
        class="btn ink"
        disabled={!dirty.value || !valid || !name.value.trim()}
        onClick={save}
      >
        {brand ? "Save changes" : "Use this brand"}
      </button>
      <p class="fn">
        This changes what you publish next. Published work keeps its look until it's published again.
      </p>
    </>
  );
}

const unique = (value: string, index: number, list: string[]) => list.indexOf(value) === index;

function BrandSettings() {
  const current = usePoll<{ brand: BrandInfo | null }>("/api/brand", 60_000);
  const proposals = usePoll<Proposal[]>("/api/brand/proposals", 60_000);
  const error = useSignal<string | null>(null);
  const copied = useSignal(false);
  const refresh = async () => {
    await Promise.all([current.refresh(), proposals.refresh()]);
  };
  const act = async (path: string, method: "POST" | "DELETE") => {
    error.value = null;
    try {
      await api(path, { method });
      await refresh();
    } catch (failure) {
      error.value = message(failure);
    }
  };
  const loaded = current.data.value;
  const brand = loaded?.brand ?? null;
  const list = proposals.data.value ?? [];
  const admin = ADMIN();
  return (
    <Frame title="Brand">
      <p class="fn">
        {brand
          ? `Templates use ${brand.name}. A project's own theme still wins.`
          : "Templates use their own look."}
      </p>
      {admin && loaded && (
        <BrandForm
          key={JSON.stringify(brand)}
          brand={brand}
          orgName={meta.value?.orgName ?? ""}
          onSaved={refresh}
        />
      )}
      {admin && (
        <>
          <span class="gh">Or ask an agent</span>
          <p class="fn">Best when you have a brand guide, or your own font files.</p>
          <button
            type="button"
            class="btn soft"
            onClick={() => {
              copy(BRAND_PROMPT);
              copied.value = true;
            }}
          >
            <Copy />
            {copied.value ? "Copied" : "Copy the prompt"}
          </button>
        </>
      )}
      {list.length > 0 && <span class="gh">Brands</span>}
      {list.length > 0 && (
        <div class="group">
          {list.map((row) => (
            <div class="li" key={row.id}>
              <span
                aria-hidden="true"
                style={`width:22px;height:22px;border-radius:50%;flex:none;background:${HEX.test(row.brand.theme.accent ?? "") ? row.brand.theme.accent : "transparent"}`}
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
              {row.current ? (
                <span class="word ok">Current</span>
              ) : (
                admin && (
                  <button
                    type="button"
                    class="btn fit"
                    onClick={() => act(`/api/brand/proposals/${row.id}/apply`, "POST")}
                  >
                    Apply
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      )}
      {error.value && <p class="err">{error.value}</p>}
      {admin && brand && (
        <button type="button" class="btn" onClick={() => act("/api/brand", "DELETE")}>
          Go back to the default
        </button>
      )}
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
  domains: Domains,
  org: OrgSettings,
  brand: BrandSettings,
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
