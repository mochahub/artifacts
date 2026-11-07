import type { Artifact, VersionRow } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { Check } from "lucide-preact";
import { useLocation } from "preact-iso";
import { api, post } from "../api.ts";
import { agentShort, ago } from "../format.ts";
import { compareHref } from "../paths.ts";
import { usePoll } from "../poll.ts";
import { useAction } from "./reauth.tsx";
import { Sheet } from "./sheet.tsx";

/** How a checkpoint was made, in the version list's words. */
const CHECKPOINT_WORDS: Record<NonNullable<VersionRow["checkpoint"]>, string> = {
  saved: "Saved",
  agent: "Checkpoint",
  delegate: "Delegate checkpoint",
  quiet: "After a quiet spell",
  handoff: "Before a publish",
};

export function VersionSheet({ artifact, onClose }: { artifact: Artifact; onClose(): void }) {
  const { route, path } = useLocation();
  const list = usePoll<VersionRow[]>(`/api/artifacts/${artifact.id}/versions`, 60_000);
  const open = useSignal<number | null>(null);
  const naming = useSignal(false);
  const name = useSignal("");
  const { run, error, sheet } = useAction();
  const clean = path.replace(/\/v\/\d+/, "");
  const canPublish = artifact.permissions.manage && !artifact.archivedAt;

  return (
    <Sheet title="Version history" onClose={onClose}>
      <div class="group">
        {list.data.value?.map((version) => {
          const current = version.n === artifact.latestVersion;
          return (
            <div key={version.n}>
              <button
                type="button"
                class="vrow"
                aria-expanded={open.value === version.n}
                onClick={() => {
                  open.value = open.value === version.n ? null : version.n;
                  naming.value = false;
                }}
              >
                {/* An agent's checkpoint carries the blue number (13, "Checkpoints"). */}
                <b style={version.agent ? { color: "var(--agent-word)" } : undefined}>v{version.n}</b>
                <div class="grow">
                  <div class="tt">{version.name ?? ago(version.publishedAt)}</div>
                  <div class="ss">
                    {version.checkpoint ? `${CHECKPOINT_WORDS[version.checkpoint]}, ` : ""}
                    {version.name ? `${ago(version.publishedAt)}, ` : ""}
                    {agentShort(version.agent ?? version.publishedBy)}
                    {current ? ", current version" : ""}
                  </div>
                </div>
                {version.decision === "approved" && (
                  <span class="word ok">
                    <Check />
                    Approved
                  </span>
                )}
              </button>
              {open.value === version.n && (
                <div class="row" style="padding:0 16px 12px;flex-wrap:wrap;gap:8px">
                  <button
                    type="button"
                    class="btn soft fit"
                    onClick={() => {
                      route(current ? clean : `${clean}?v=${version.n}`);
                      onClose();
                    }}
                  >
                    Preview
                  </button>
                  {canPublish && !current && (
                    <button
                      type="button"
                      class="btn ink fit"
                      onClick={() =>
                        run(async () => {
                          await post(`/api/artifacts/${artifact.id}/versions/${version.n}/restore`);
                          onClose();
                        })
                      }
                    >
                      Restore
                    </button>
                  )}
                  {!current && (
                    <a class="btn soft fit" href={compareHref(artifact, version.n, artifact.latestVersion)}>
                      Compare
                    </a>
                  )}
                  {canPublish && (
                    <button
                      type="button"
                      class="btn soft fit"
                      onClick={() => {
                        naming.value = !naming.value;
                        name.value = version.name ?? "";
                      }}
                    >
                      Name
                    </button>
                  )}
                  {naming.value && (
                    <form
                      class="row"
                      style="width:100%"
                      onSubmit={(event) => {
                        event.preventDefault();
                        run(async () => {
                          await api(`/api/artifacts/${artifact.id}/versions/${version.n}`, {
                            method: "PATCH",
                            json: { name: name.value || null },
                          });
                          naming.value = false;
                          await list.refresh();
                        });
                      }}
                    >
                      <input
                        class="field grow"
                        aria-label="Version name"
                        value={name.value}
                        onInput={(e) => {
                          name.value = e.currentTarget.value;
                        }}
                      />
                      <button type="submit" class="btn ink fit">
                        Save
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error.value && <p class="err">{error.value}</p>}
      {sheet}
    </Sheet>
  );
}
