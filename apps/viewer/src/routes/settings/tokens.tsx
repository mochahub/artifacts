import type { ProjectRow, TokenScope } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { Check } from "lucide-preact";
import { del, post } from "../../api.ts";
import { useAction } from "../../components/reauth.tsx";
import { ago } from "../../format.ts";
import { usePoll } from "../../poll.ts";
import { Frame } from "./frame.tsx";

type TokenRow = { id: string; name: string; scopes: TokenScope[]; lastUsedAt: string | null };

const SCOPES = ["publish", "read", "org"] as const satisfies readonly TokenScope[];

export function Tokens() {
  const list = usePoll<TokenRow[]>("/api/tokens", 60_000);
  const action = useAction();
  const name = useSignal("");
  const made = useSignal<string | null>(null);
  const projects = usePoll<ProjectRow[]>("/api/projects", 60_000);
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
          action.run(async () => {
            const { token } = await post<{ token: string }>("/api/tokens", {
              name: name.value,
              scopes: SCOPES,
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
      {action.error.value && <p class="err">{action.error.value}</p>}
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
                onClick={() =>
                  action.run(async () => {
                    await del(`/api/tokens/${row.id}`);
                    await list.refresh();
                  })
                }
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
      {action.sheet}
    </Frame>
  );
}
