import { useSignal } from "@preact/signals";
import { X } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import { ApiFailure, post } from "../api.ts";

/** Confirms who's there before a sensitive action, then calls `done` so it can be retried (04). */
export function ReauthSheet({ onDone, onCancel }: { onDone(): void; onCancel(): void }) {
  const password = useSignal("");
  const error = useSignal<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

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
        {error.value && <p class="err">{error.value}</p>}
        <button class="btn ink" type="submit">
          Confirm
        </button>
      </form>
    </>
  );
}
