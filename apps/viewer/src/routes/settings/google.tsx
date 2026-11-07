import type { GoogleSettings } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { Copy } from "lucide-preact";
import { useLocation } from "preact-iso";
import { api, post } from "../../api.ts";
import { copy } from "../../clipboard.ts";
import { Loaded } from "../../components/loaded.tsx";
import { PlaceholderRows } from "../../components/placeholder.tsx";
import { googleLink, useAction } from "../../components/reauth.tsx";
import { googleAnswer } from "../../google.ts";
import { usePoll } from "../../poll.ts";
import { refreshMeta } from "../../session.ts";
import { Frame } from "./frame.tsx";

export function GoogleSetup() {
  const settings = usePoll<GoogleSettings>("/api/org/google", 60_000);
  return (
    <Frame title="Google sign-in" back="/settings/sign-in" backLabel="Sign-in">
      <Loaded from={[settings]} value={settings.data.value} placeholder={<PlaceholderRows rows={2} />}>
        {(body) => <Setup body={body} refresh={settings.refresh} />}
      </Loaded>
    </Frame>
  );
}

function Setup({ body, refresh }: { body: GoogleSettings; refresh(): Promise<void> }) {
  const { query } = useLocation();
  const action = useAction();
  const clientId = useSignal<string | null>(null);
  const secret = useSignal("");
  const domain = useSignal<string | null>(null);
  const answer = googleAnswer("settings", query.google);
  const change = (json: unknown) =>
    action.run(async () => {
      await api("/api/org/google", { method: "PATCH", json });
      await refresh();
      await refreshMeta();
    });
  return (
    <>
      <p class="sub">
        Optional. People still need an invite, and passwords and passkeys keep working. Create a client in
        Google Cloud, of type Web application, and add these as its redirect URIs:
      </p>
      <div class="group">
        {body.redirectUris.map((uri) => (
          <button type="button" class="li btn-li" key={uri} onClick={() => copy(uri)}>
            <div class="grow">
              <div class="mono" style="font-size:14px;overflow-wrap:anywhere">
                {uri}
              </div>
            </div>
            <Copy />
          </button>
        ))}
      </div>
      <label class="gh" for="google-id">
        Client ID
      </label>
      <input
        id="google-id"
        class="field"
        autocomplete="off"
        value={clientId.value ?? body.clientId ?? ""}
        onInput={(e) => {
          clientId.value = e.currentTarget.value;
        }}
      />
      <label class="gh" for="google-secret">
        Client secret
      </label>
      <input
        id="google-secret"
        class="field"
        type="password"
        autocomplete="off"
        placeholder={body.hasSecret ? "Saved, and never shown again" : ""}
        value={secret.value}
        onInput={(e) => {
          secret.value = e.currentTarget.value;
        }}
      />
      <button
        type="button"
        class="btn soft"
        disabled={!(clientId.value ?? body.clientId) || (!body.hasSecret && !secret.value)}
        onClick={() =>
          action.run(async () => {
            await api("/api/org/google", {
              method: "PUT",
              json: {
                clientId: clientId.value ?? body.clientId,
                ...(secret.value ? { clientSecret: secret.value } : {}),
              },
            });
            secret.value = "";
            await refresh();
            await refreshMeta();
          })
        }
      >
        Save
      </button>
      {answer && <p class="fn">{answer}</p>}
      {body.clientId && body.hasSecret && (
        <>
          <span class="gh">Test</span>
          <p class="fn">
            Sign in to Google once to prove these work. Google can only be turned on after that, by the admin
            who ran it. Saving new credentials turns it off again.
          </p>
          <button
            type="button"
            class="btn soft"
            onClick={() =>
              action.run(async () => {
                await post("/api/auth/reauth/check");
                location.href = googleLink("test", "/settings/google");
              })
            }
          >
            {body.tested ? "Test again" : "Test"}
          </button>
          <span class="gh">For everyone</span>
          <div class="seg">
            {[true, false].map((value) => (
              <button
                type="button"
                key={String(value)}
                aria-pressed={body.enabled === value}
                disabled={value && !body.tested && !body.enabled}
                onClick={() => change({ enabled: value })}
              >
                {value ? "On" : "Off"}
              </button>
            ))}
          </div>
          <span class="gh">Join without an invite</span>
          <label class="gh" for="google-domain">
            Google Workspace domain
          </label>
          <input
            id="google-domain"
            class="field"
            autocomplete="off"
            placeholder="Off"
            value={domain.value ?? body.autoJoin?.domain ?? ""}
            onInput={(e) => {
              domain.value = e.currentTarget.value;
            }}
          />
          <p class="fn">
            Off unless you set it. Anyone Google says belongs to this Workspace can then join as a member.
            Consumer addresses such as gmail.com can't be used.
          </p>
          <button
            type="button"
            class="btn soft"
            onClick={() => {
              const value = (domain.value ?? body.autoJoin?.domain ?? "").trim();
              change({
                autoJoin: value
                  ? { domain: value, role: body.autoJoin?.role ?? "member", teamIds: [] }
                  : null,
              });
            }}
          >
            Save domain
          </button>
        </>
      )}
      {action.error.value && <p class="err">{action.error.value}</p>}
      {action.sheet}
    </>
  );
}
