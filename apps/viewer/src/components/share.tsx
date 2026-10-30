import type { Artifact } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { Check, Copy, Eye, Link2Off, MessageCircle } from "lucide-preact";
import { ApiFailure, api, post } from "../api.ts";
import { usePoll } from "../poll.ts";
import { Sheet } from "./sheets.tsx";

type Access = {
  people: { id: string; name: string; email: string; permission: string }[];
  links: { id: string; permission: string; expiresAt: string | null }[];
};

const message = (failure: unknown) =>
  failure instanceof ApiFailure ? failure.message : "Something went wrong.";

/** People and links for one artifact (05·1). Links are shown once, then revoked by row. */
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
  const email = useSignal("");
  const invitePermission = useSignal("comment");
  const error = useSignal<string | null>(null);

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
      navigator.clipboard?.writeText(made.url).catch(() => {});
    });
  const addPerson = () =>
    run(async () => {
      const made = await post<{ url?: string }>(`/api/artifacts/${artifact.id}/access`, {
        email: email.value,
        permission: invitePermission.value,
      });
      email.value = "";
      if (made.url) {
        url.value = made.url;
        navigator.clipboard?.writeText(made.url).catch(() => {});
      }
    });

  return (
    <Sheet title="Share" onClose={onClose}>
      <span class="gh">Visible to</span>
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
            {value === "org" ? "Organization" : "Only me"}
          </button>
        ))}
      </div>
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
      {(access.data.value?.links.length ?? 0) > 0 && (
        <div class="group">
          {access.data.value?.links.map((link) => (
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
      <span class="gh">People</span>
      <input
        class="field"
        type="email"
        aria-label="Add by email"
        placeholder="sam@example.com"
        value={email.value}
        onInput={(e) => {
          email.value = e.currentTarget.value;
        }}
      />
      <div class="seg">
        {[
          ["view", "View"],
          ["comment", "Comment"],
          ["publish", "Publish"],
        ].map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={invitePermission.value === value}
            onClick={() => {
              invitePermission.value = value as string;
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <button type="button" class="btn soft" disabled={!email.value} onClick={addPerson}>
        Add person
      </button>
      {(access.data.value?.people.length ?? 0) > 0 && (
        <div class="group">
          {access.data.value?.people.map((person) => (
            <div class="li" key={person.id}>
              <span class="av">{person.name[0]}</span>
              <div class="grow">
                <div class="tt">{person.name}</div>
                <div class="ss">{person.permission}</div>
              </div>
              <button
                type="button"
                class="icon-btn"
                aria-label={`Remove ${person.name}`}
                onClick={() =>
                  run(() => api(`/api/artifacts/${artifact.id}/access/${person.id}`, { method: "DELETE" }))
                }
              >
                <Link2Off />
              </button>
            </div>
          ))}
        </div>
      )}
      {error.value && <p class="err">{error.value}</p>}
    </Sheet>
  );
}
