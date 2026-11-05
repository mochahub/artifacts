import { useSignal } from "@preact/signals";
import { X } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import { ApiFailure, api, post } from "../api.ts";
import { assertion } from "../passkey.ts";

type Ways = { identities: unknown[]; passkeys: number; password: boolean; google: boolean };

/** Starts a round trip that comes back to this page. It's a link: CSP stops a form leaving the site. */
export const googleLink = (intent: string, next = `${location.pathname}${location.search}`) =>
  `/api/auth/google/start?intent=${intent}&next=${encodeURIComponent(next)}`;

/** Confirms who's there before a sensitive action, then calls `done` so it can be retried (04). */
export function ReauthSheet({ onDone, onCancel }: { onDone(): void; onCancel(): void }) {
  const ways = useSignal<Ways | null>(null);
  const password = useSignal("");
  // A round trip that didn't confirm them lands back here, so the reason shows in the sheet.
  const came = new URLSearchParams(location.search).get("google");
  const error = useSignal<string | null>(
    came === "mismatch"
      ? "That's a different Google account."
      : came === "failed" || came === "expired"
        ? "Google didn't confirm it. Try again."
        : null,
  );
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api<Ways>("/api/me/identities")
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

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    try {
      await post("/api/auth/reauth", { password: password.value });
      onDone();
    } catch (failure) {
      error.value = failure instanceof ApiFailure ? failure.message : "Something went wrong.";
    }
  }

  return (
    <>
      <div class="dim" />
      <form class="sheet" onSubmit={submit}>
        <div class="grabber" />
        <div class="shead">
          <div class="t">Confirm it's you</div>
          <button type="button" class="x" aria-label="Close" onClick={onCancel}>
            <X />
          </button>
        </div>
        {hasPasskey && (
          <button
            type="button"
            class="btn ink"
            onClick={async () => {
              try {
                await post("/api/auth/reauth", await assertion());
                onDone();
              } catch (failure) {
                error.value = failure instanceof ApiFailure ? failure.message : "That passkey didn't work.";
              }
            }}
          >
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
    </>
  );
}
