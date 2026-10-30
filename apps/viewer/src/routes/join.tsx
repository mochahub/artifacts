import type { Person } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { ScanFace } from "lucide-preact";
import { useEffect } from "preact/hooks";
import { useLocation, useRoute } from "preact-iso";
import { ApiFailure, api, post } from "../api.ts";
import { addPasskey, passkeyName } from "../passkey.ts";
import { me, meta } from "../session.ts";

type Preview = {
  orgName: string;
  invitedBy: string;
  role: string;
  email: string;
  artifact?: { title: string };
};

/** One screen: a passkey is the default, because it's one tap on a phone (06·6). */
export function Join() {
  const { params } = useRoute();
  const { route } = useLocation();
  const preview = useSignal<Preview | null>(null);
  const gone = useSignal(false);
  const name = useSignal("");
  const password = useSignal("");
  const usePassword = useSignal(false);
  const error = useSignal<string | null>(null);
  const token = encodeURIComponent(params.token ?? "");

  useEffect(() => {
    api<Preview>(`/api/invites/${token}`)
      .then((body) => {
        preview.value = body;
      })
      .catch(() => {
        gone.value = true;
      });
  }, [token, preview, gone]);

  async function accept(withPasskey: boolean) {
    error.value = null;
    try {
      const { person } = await post<{ person: Person }>(`/api/invites/${token}/accept`, {
        name: name.value,
        ...(withPasskey ? {} : { password: password.value }),
      });
      me.value = person;
      if (withPasskey) await addPasskey(passkeyName());
      route("/", true);
    } catch (failure) {
      error.value =
        failure instanceof ApiFailure
          ? failure.message
          : "That didn't work. You can add a passkey in Settings.";
      if (me.value) route("/settings/sign-in", true);
    }
  }

  if (gone.value) {
    return (
      <main class="screen">
        <h1 class="h1 m">This invite no longer works</h1>
        <p class="sub">Invites work once, for 7 days. Ask for a new one.</p>
      </main>
    );
  }
  const invite = preview.value;
  if (!invite) return null;
  return (
    <main class="screen">
      <div class="row">
        <span class="logo" />
        <b>{meta.value?.orgName}</b>
      </div>
      <p class="sub">
        {invite.invitedBy} invited you{" "}
        {invite.artifact ? `to ${invite.artifact.title}` : `as a ${invite.role}`}
      </p>
      <h1 class="h1">Join {invite.orgName}</h1>
      <label class="gh" for="join-name">
        Your name
      </label>
      <input
        id="join-name"
        class="field"
        autocomplete="name"
        value={name.value}
        onInput={(e) => {
          name.value = e.currentTarget.value;
        }}
      />
      <span class="gh">Email</span>
      <div class="field" style="color:var(--tx2)">
        {invite.email}
      </div>
      {usePassword.value && (
        <>
          <label class="gh" for="join-password">
            Password
          </label>
          <input
            id="join-password"
            class="field"
            type="password"
            autocomplete="new-password"
            minLength={12}
            value={password.value}
            onInput={(e) => {
              password.value = e.currentTarget.value;
            }}
          />
        </>
      )}
      {error.value && <p class="err">{error.value}</p>}
      <div class="spacer" />
      {usePassword.value ? (
        <button
          type="button"
          class="btn ink"
          disabled={!name.value || password.value.length < 12}
          onClick={() => accept(false)}
        >
          Join
        </button>
      ) : (
        <>
          <button type="button" class="btn ink" disabled={!name.value} onClick={() => accept(true)}>
            <ScanFace />
            Create a passkey
          </button>
          <button
            type="button"
            class="btn"
            onClick={() => {
              usePassword.value = true;
            }}
          >
            Use a password instead
          </button>
        </>
      )}
      <p class="fn center">You can add the other one later in Settings.</p>
    </main>
  );
}
