import type { IdentityList } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { ApiFailure, api, message, post } from "../api.ts";
import { googleAnswer } from "../google.ts";
import { assertion } from "../passkey.ts";
import { googleStart } from "../paths.ts";
import { Sheet } from "./sheet.tsx";

/** A Google round trip that comes back to this page. */
export const googleLink = (intent: string, next = `${location.pathname}${location.search}`) =>
  googleStart(intent, { next });

/** Confirms who's there before a sensitive action, then calls `done` so it can be retried (04). */
function ReauthSheet({ onDone, onCancel }: { onDone(): void; onCancel(): void }) {
  const ways = useSignal<IdentityList | null>(null);
  const password = useSignal("");
  // A round trip that didn't confirm them lands back here, so the reason shows in the sheet.
  const error = useSignal(googleAnswer("reauth", new URLSearchParams(location.search).get("google")));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api<IdentityList>("/api/me/identities")
      .then((body) => {
        ways.value = body;
      })
      .catch(() => {});
  }, [ways]);
  useEffect(() => input.current?.focus(), [ways.value]);
  // Until it's known, everything shows: nobody should be stuck on a failed lookup.
  const hasPasskey = !ways.value || ways.value.passkeys > 0;
  const hasPassword = !ways.value || ways.value.password;
  const hasGoogle = Boolean(ways.value?.google && ways.value.identities.length > 0);

  async function prove(proof: () => Promise<object>, fallback?: string) {
    try {
      await post("/api/auth/reauth", await proof());
      onDone();
    } catch (failure) {
      error.value = message(failure, fallback);
    }
  }

  return (
    <Sheet title="Confirm it's you" onClose={onCancel}>
      {/* Not a box of its own: the sheet lays out what's in it. */}
      <form
        style="display:contents"
        onSubmit={(event) => {
          event.preventDefault();
          prove(async () => ({ password: password.value }));
        }}
      >
        {hasPasskey && (
          <button type="button" class="btn ink" onClick={() => prove(assertion, "That passkey didn't work.")}>
            Use a passkey
          </button>
        )}
        {hasGoogle && (
          <>
            <a class={`btn ${hasPasskey ? "soft" : "ink"}`} href={googleLink("reauth")}>
              Continue with Google
            </a>
            <p class="fn">You'll come back to this page. Tap again when you do.</p>
          </>
        )}
        {hasPassword && (
          <>
            <label class="gh" for="reauth-password">
              Password
            </label>
            <input
              ref={input}
              id="reauth-password"
              class="field"
              type="password"
              autocomplete="current-password"
              value={password.value}
              onInput={(e) => {
                password.value = e.currentTarget.value;
              }}
            />
          </>
        )}
        {error.value && <p class="err">{error.value}</p>}
        {hasPassword && (
          <button class="btn soft" type="submit">
            Confirm
          </button>
        )}
      </form>
    </Sheet>
  );
}

/**
 * Runs what a button does, and says what went wrong. Something that needs a recent sign-in (04) asks for
 * one in a sheet, then runs again. `after` runs on success, such as a refresh; render `sheet` in the page.
 */
export function useAction({ after, beforeReauth }: { after?(): unknown; beforeReauth?(): void } = {}) {
  const pending = useSignal<(() => Promise<unknown>) | null>(null);
  const error = useSignal<string | null>(null);
  async function run(work: () => Promise<unknown>) {
    error.value = null;
    try {
      await work();
      await after?.();
    } catch (failure) {
      if (failure instanceof ApiFailure && failure.code === "recent_auth_required") {
        beforeReauth?.();
        pending.value = work;
      } else error.value = message(failure);
    }
  }
  const sheet = pending.value ? (
    <ReauthSheet
      onCancel={() => {
        pending.value = null;
      }}
      onDone={() => {
        const work = pending.value;
        pending.value = null;
        if (work) run(work);
      }}
    />
  ) : null;
  return { run, error, sheet };
}
