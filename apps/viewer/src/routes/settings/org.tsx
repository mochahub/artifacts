import type { OrgInfo } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { api } from "../../api.ts";
import { Loaded } from "../../components/loaded.tsx";
import { PlaceholderRows } from "../../components/placeholder.tsx";
import { useAction } from "../../components/reauth.tsx";
import { usePoll } from "../../poll.ts";
import { Frame } from "./frame.tsx";

export function OrgSettings() {
  const org = usePoll<OrgInfo>("/api/org", 60_000);
  return (
    <Frame title="Organization">
      <Loaded from={[org]} value={org.data.value} placeholder={<PlaceholderRows rows={3} />}>
        {(body) => <Form body={body} refresh={org.refresh} />}
      </Loaded>
    </Frame>
  );
}

function Form({ body, refresh }: { body: OrgInfo; refresh(): Promise<void> }) {
  const name = useSignal<string | null>(null);
  const action = useAction({ after: refresh });
  const save = (json: unknown) => action.run(() => api("/api/org", { method: "PATCH", json }));
  return (
    <>
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
      {action.error.value && <p class="err">{action.error.value}</p>}
      {action.sheet}
    </>
  );
}
