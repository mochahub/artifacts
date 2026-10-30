import type { Person } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { ScanFace } from "lucide-preact";
import { useEffect } from "preact/hooks";
import { useLocation } from "preact-iso";
import { ApiFailure, post } from "../api.ts";
import { canUseHomePasskey, signInWithPasskey } from "../passkey.ts";
import { me, meta } from "../session.ts";

/** Only same-site paths, so a crafted link can't send someone elsewhere after signing in. */
export function safeNext(value: string | undefined) {
  return value?.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/";
}

export function SignIn() {
  const { route, query } = useLocation();
  const email = useSignal("");
  const password = useSignal("");
  const error = useSignal<string | null>(null);
  const busy = useSignal(false);
  const related = useSignal(true);
  useEffect(() => {
    canUseHomePasskey().then((yes) => {
      related.value = yes;
    });
  }, [related]);

  async function withPasskey() {
    error.value = null;
    try {
      me.value = await signInWithPasskey();
      route(safeNext(query.next), true);
    } catch (failure) {
      error.value =
        failure instanceof ApiFailure ? failure.message : "That passkey didn't work. Try your password.";
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy.value = true;
    error.value = null;
    try {
      const { person } = await post<{ person: Person }>("/api/auth/password", {
        email: email.value,
        password: password.value,
      });
      me.value = person;
      route(safeNext(query.next), true);
    } catch (failure) {
      error.value = failure instanceof ApiFailure ? failure.message : "Something went wrong.";
      busy.value = false;
    }
  }

  return (
    <main class="screen">
      <div class="row">
        <span class="logo" />
        <b>{meta.value?.orgName}</b>
      </div>
      <h1 class="h1">Sign in</h1>
      <button type="button" class="btn ink" onClick={withPasskey}>
        <ScanFace />
        Sign in with a passkey
      </button>
      {!related.value && (
        <a class="fn center" href={`https://${meta.value?.homeDomain}/sign-in`}>
          Sign in on {meta.value?.homeDomain}
        </a>
      )}
      <p class="fn center">or use your password</p>
      <form style="display:flex;flex-direction:column;gap:16px" onSubmit={submit}>
        <label class="gh" for="email">
          Email
        </label>
        <input
          id="email"
          class="field"
          type="email"
          autocomplete="username"
          required
          value={email.value}
          onInput={(e) => {
            email.value = e.currentTarget.value;
          }}
        />
        <label class="gh" for="password">
          Password
        </label>
        <input
          id="password"
          class="field"
          type="password"
          autocomplete="current-password"
          required
          value={password.value}
          onInput={(e) => {
            password.value = e.currentTarget.value;
          }}
        />
        {error.value && <p class="err">{error.value}</p>}
        <button class="btn soft" type="submit" disabled={busy.value}>
          Sign in
        </button>
      </form>
      <div class="spacer" />
      <p class="fn center">
        Forgot your password? Ask an admin for a reset link.
        <br />
        New here? You need an invite.
      </p>
    </main>
  );
}
