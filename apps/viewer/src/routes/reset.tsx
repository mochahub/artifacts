import type { Person } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { useLocation, useRoute } from "preact-iso";
import { ApiFailure, api, post } from "../api.ts";
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
    api<{ email: string }>(`/api/reset/${token}`)
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
      const { person } = await post<{ person: Person }>(`/api/reset/${token}`, { password: password.value });
      me.value = person;
      route("/", true);
    } catch (failure) {
      error.value = failure instanceof ApiFailure ? failure.message : "Something went wrong.";
    }
  }

  if (gone.value) {
    return (
      <main class="screen">
        <h1 class="h1 m">This link no longer works</h1>
        <p class="sub">Reset links work once, for one hour. Ask an admin for a new one.</p>
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
          minLength={12}
          required
          value={password.value}
          onInput={(e) => {
            password.value = e.currentTarget.value;
          }}
        />
        <p class="fn">At least 12 characters. Your other sign-ins end when you save.</p>
        {error.value && <p class="err">{error.value}</p>}
        <button class="btn ink" type="submit">
          Save password
        </button>
      </form>
    </main>
  );
}
