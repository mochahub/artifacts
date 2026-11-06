import type { InviteCreated, PeopleList, ResetLinkCreated, TeamList, UrlResponse } from "@artifacts/schema";
import { INVITE_DAYS, type InviteRole, RESET_HOURS } from "@artifacts/schema/constants";
import { useSignal } from "@preact/signals";
import { Check, Copy, Plus, X } from "lucide-preact";
import { api, del, post } from "../../api.ts";
import { copy } from "../../clipboard.ts";
import { Avatar } from "../../components/cards.tsx";
import { useAction } from "../../components/reauth.tsx";
import { Sheet } from "../../components/sheet.tsx";
import { capitalize, plural, until } from "../../format.ts";
import { projectHref, teamHref } from "../../paths.ts";
import { usePoll } from "../../poll.ts";
import { me, meta } from "../../session.ts";
import { Frame } from "./frame.tsx";

type PersonRow = PeopleList["people"][number];

/** What each role can do, as the invite sheet says it. Every role is here, so a new one needs words. */
const ROLE_NOTES: Record<InviteRole, string> = {
  member: "Members publish, comment and share their own work.",
  reviewer: "Reviewers read and comment. They can't publish.",
  admin: "Admins manage people and settings.",
};
const ROLE_CHOICES = ["member", "reviewer", "admin"] as const satisfies readonly InviteRole[];

export function People() {
  const tab = useSignal<"org" | "outside">("org");
  const list = usePoll<PeopleList>(`/api/people${tab.value === "outside" ? "?kind=outside" : ""}`, 60_000);
  const inviting = useSignal(false);
  const selected = useSignal<PersonRow | null>(null);
  const email = useSignal("");
  const role = useSignal<InviteRole>("member");
  const link = useSignal<string | null>(null);
  const teams = usePoll<TeamList>("/api/teams", 60_000);
  const joining = useSignal<string[]>([]);
  const action = useAction({ after: list.refresh });
  /** Shows a new link and copies it: invites aren't emailed. */
  const show = (url: string) => {
    link.value = url;
    copy(url);
  };

  const invite = () =>
    action.run(async () => {
      const { url } = await post<InviteCreated>("/api/invites", {
        email: email.value,
        role: role.value,
        teamIds: joining.value,
      });
      show(url);
    });

  const person = selected.value;
  const error = action.error.value;
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
            <Avatar name={row.name} you={row.id === me.value?.id} />
            <div class="grow">
              <div class="tt">{row.name}</div>
              <div class="ss">
                {tab.value === "outside"
                  ? row.shares.map((share) => share.title).join(", ")
                  : `${capitalize(row.role)}, ${row.email}`}
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
                  {capitalize(row.role)}, expires {until(row.expiresAt)}
                </div>
              </div>
              <button
                type="button"
                class="icon-btn"
                aria-label={`Copy a new link for ${row.email}`}
                onClick={() =>
                  action.run(async () => show((await post<UrlResponse>(`/api/invites/${row.id}/link`)).url))
                }
              >
                <Copy />
              </button>
              <button
                type="button"
                class="icon-btn"
                aria-label={`Revoke the invite for ${row.email}`}
                onClick={() => action.run(() => del(`/api/invites/${row.id}`))}
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
      {error && !inviting.value && !person && <p class="err">{error}</p>}
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
            {ROLE_CHOICES.map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={role.value === value}
                onClick={() => {
                  role.value = value;
                }}
              >
                {capitalize(value)}
              </button>
            ))}
          </div>
          <p class="fn">{ROLE_NOTES[role.value]}</p>
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
          {error && <p class="err">{error}</p>}
          <button type="button" class="btn ink" disabled={!email.value} onClick={invite}>
            <Copy />
            Copy invite link
          </button>
          <p class="fn center">
            Send it yourself in Messages or Slack. It works once and expires in {plural(INVITE_DAYS, "day")}.
          </p>
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
              <span class="ss">{capitalize(person.role)}</span>
            </div>
            <div class="li">
              <div class="grow">
                <div class="tt">Sign-in</div>
              </div>
              <span class="ss">
                {[
                  person.password ? "Password" : null,
                  person.passkeys ? "Passkey" : null,
                  person.google ? "Google" : null,
                ]
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
                      <a href={teamHref(team.slug)}>{team.name}</a>
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
                      <a href={projectHref(project.slug)}>{project.name}</a>
                    </span>
                  ))}
                </span>
              </div>
            )}
          </div>
          {person.role !== "outside" && (
            <div class="seg">
              {ROLE_CHOICES.map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={person.role === value}
                  onClick={() =>
                    action.run(async () => {
                      await api(`/api/people/${person.id}`, { method: "PATCH", json: { role: value } });
                      selected.value = { ...person, role: value };
                    })
                  }
                >
                  {capitalize(value)}
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
              action.run(async () =>
                show((await post<ResetLinkCreated>(`/api/people/${person.id}/reset-link`)).url),
              )
            }
          >
            <Copy />
            Copy reset link
          </button>
          <p class="fn">
            Works once, for {plural(RESET_HOURS, "hour")}. {person.name}'s other sign-ins end when the
            password changes.
          </p>
          {error && <p class="err">{error}</p>}
          <button
            type="button"
            class="btn soft"
            style="color:var(--warn-word)"
            onClick={() =>
              action.run(async () => {
                if (!confirm(`Remove ${person.name} from ${meta.value?.orgName}?`)) return;
                await del(`/api/people/${person.id}`);
                selected.value = null;
              })
            }
          >
            Remove {person.name} from {meta.value?.orgName}
          </button>
        </Sheet>
      )}
      {action.sheet}
    </Frame>
  );
}
