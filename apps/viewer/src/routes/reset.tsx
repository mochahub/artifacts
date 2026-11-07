import type { PersonResponse, ResetPreview } from "@artifacts/schema";
import { PASSWORD_MIN, RESET_HOURS } from "@artifacts/schema/constants";
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { useLocation, useRoute } from "preact-iso";
import { api, message, post } from "../api.ts";
import { plural } from "../format.ts";
import { me } from "../session.ts";

export function Reset() {
  const { params } = useRoute();
  const { route } = useLocation();
  const email = useSignal<string | null>(null);
  const gone = useSignal(false);
  const password = useSignal("");
  const error = useSignal<string | null>(null);
  const token = encodeURIComponent(params.token ?? "");

  useEffect(() => {
    api<ResetPreview>(`/api/reset/${token}`)
      .then((body) => {
        email.value = body.email;
      })
      .catch(() => {
        gone.value = true;
      });
  }, [token, email, gone]);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    try {
      const { person } = await post<PersonResponse>(`/api/reset/${token}`, { password: password.value });
      me.value = person;
      route("/", true);
    } catch (failure) {
      error.value = message(failure);
    }
  }

  if (gone.value) {
    return (
      <main class="screen">
        <h1 class="h1 m">This link no longer works</h1>
        <p class="sub">
          Reset links work once, for {plural(RESET_HOURS, "hour")}. Ask an admin for a new one.
        </p>
      </main>
    );
  }

  return (
    <main class="screen">
      <h1 class="h1">Set a new password</h1>
      {email.value && <p class="sub">For {email.value}</p>}
      <form style="display:flex;flex-direction:column;gap:16px" onSubmit={submit}>
        <label class="gh" for="new-password">
          New password
        </label>
        <input
          id="new-password"
          class="field"
          type="password"
          autocomplete="new-password"
          minLength={PASSWORD_MIN}
          required
          value={password.value}
          onInput={(e) => {
            password.value = e.currentTarget.value;
          }}
        />
        <p class="fn">At least {PASSWORD_MIN} characters. Your other sign-ins end when you save.</p>
        {error.value && <p class="err">{error.value}</p>}
        <button class="btn ink" type="submit">
          Save password
        </button>
      </form>
    </main>
  );
}
