import type { TeamCreated, TeamList, TeamDetail as TeamPage } from "@artifacts/schema";
import { TEAM_ABOUT_MAX, TEAM_NAME_MAX } from "@artifacts/schema/constants";
import { useSignal } from "@preact/signals";
import { ChevronRight, Plus, Users, X } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useLocation } from "preact-iso";
import { api, del, post } from "../../api.ts";
import { Avatar } from "../../components/cards.tsx";
import { Loaded } from "../../components/loaded.tsx";
import { LoadFailed, PlaceholderRows } from "../../components/placeholder.tsx";
import { useAction } from "../../components/reauth.tsx";
import { LEVELS, Picker } from "../../components/share.tsx";
import { Sheet } from "../../components/sheet.tsx";
import { capitalize, plural } from "../../format.ts";
import { artifactHref, teamHref } from "../../paths.ts";
import { usePoll } from "../../poll.ts";
import { me } from "../../session.ts";
import { Frame, isAdmin } from "./frame.tsx";

export function Teams() {
  const list = usePoll<TeamList>("/api/teams", 60_000);
  const creating = useSignal(false);
  const name = useSignal("");
  const about = useSignal("");
  const { route } = useLocation();
  const action = useAction();
  const create = () =>
    action.run(async () => {
      const { team } = await post<TeamCreated>("/api/teams", {
        name: name.value,
        description: about.value || null,
      });
      route(teamHref(team.slug));
    });
  const rows = list.data.value?.teams ?? [];
  return (
    <Frame title="Teams">
      {isAdmin() && (
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
            <a class="li" href={teamHref(team.slug)} key={team.id}>
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
            maxLength={TEAM_NAME_MAX}
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
            maxLength={TEAM_ABOUT_MAX}
            value={about.value}
            onInput={(e) => {
              about.value = e.currentTarget.value;
            }}
          />
          {action.error.value && <p class="err">{action.error.value}</p>}
          <button type="button" class="btn ink" disabled={!name.value.trim()} onClick={create}>
            Create team
          </button>
        </Sheet>
      )}
      {action.sheet}
    </Frame>
  );
}

export function TeamDetail({ slug }: { slug: string }) {
  const page = usePoll<TeamPage>(`/api/teams/${encodeURIComponent(slug)}`, 60_000);
  if (page.error.value?.status === 404) return <Frame title="No such team">{null}</Frame>;
  const waiting = (inner: ComponentChildren) => (
    <Frame
      title={<span class="ph-line" style="width:50%;height:30px" />}
      back="/settings/teams"
      backLabel="Teams"
    >
      {inner}
    </Frame>
  );
  return (
    <Loaded
      from={[page]}
      value={page.data.value}
      placeholder={waiting(<PlaceholderRows rows={3} />)}
      failed={(retry) => waiting(<LoadFailed retry={retry} />)}
    >
      {(body) => <TeamView slug={slug} body={body} refresh={page.refresh} />}
    </Loaded>
  );
}

function TeamView({ slug, body, refresh }: { slug: string; body: TeamPage; refresh(): Promise<void> }) {
  const { route } = useLocation();
  const renaming = useSignal<string | null>(null);
  const action = useAction({ after: refresh });
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
            action.run(() => api(`${path}/members/${choice.id}`, { method: "PUT", json: { role: "member" } }))
          }
        />
      )}
      <span class="gh">{plural(team.members, "person", "people")}</span>
      {members.length > 0 && (
        <div class="group">
          {members.map((member) => (
            <div class="li" key={member.id}>
              <Avatar name={member.name} you={member.id === me.value?.id} />
              <div class="grow">
                <div class="tt">{member.name}</div>
                <div class="ss">
                  {member.email}
                  {["outside", "reviewer"].includes(member.orgRole) && `, ${capitalize(member.orgRole)}`}
                </div>
              </div>
              {permissions.members && !["outside", "reviewer"].includes(member.orgRole) ? (
                <select
                  class="level"
                  aria-label={`Role for ${member.name}`}
                  value={member.role}
                  onChange={(e) => {
                    const role = e.currentTarget.value;
                    action.run(() => api(`${path}/members/${member.id}`, { method: "PUT", json: { role } }));
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
                  onClick={() => action.run(() => del(`${path}/members/${member.id}`))}
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
            <a class="li" href={artifactHref(row)} key={row.id}>
              <div class="grow">
                <div class="tt">{row.title}</div>
                <div class="ss">{LEVELS[row.level]}</div>
              </div>
              <ChevronRight class="chev" />
            </a>
          ))}
        </div>
      )}
      {action.error.value && <p class="err">{action.error.value}</p>}
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
              action.run(async () => {
                if (!confirm(`Delete ${team.name}? Everyone in it loses what the team was given.`)) return;
                await del(path);
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
            maxLength={TEAM_NAME_MAX}
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
              action.run(async () => {
                await api(path, { method: "PATCH", json: { name: renaming.value } });
                renaming.value = null;
              })
            }
          >
            Save
          </button>
        </Sheet>
      )}
      {action.sheet}
    </Frame>
  );
}
