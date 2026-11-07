import type { DeviceDetails } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { Laptop, Lock, Terminal } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import { api, message, post } from "../api.ts";
import { useAction } from "../components/reauth.tsx";
import { signInHref } from "../paths.ts";
import { me } from "../session.ts";
import { forgetStored, readStored, writeStored } from "../storage.ts";

const KEPT_CODE = "artifacts.device-code";

/** Type the code the CLI printed. It's never in the link, so a link alone can't approve a stranger (03). */
export function Device() {
  const { route, path, query } = useLocation();
  // A Google round trip reloads the page. The person typed this, so it only lasts for this tab.
  const [kept] = useState(() => (query.google ? (readStored(KEPT_CODE, "session") ?? "") : ""));
  const code = useSignal(kept);
  const details = useSignal<DeviceDetails | null>(null);
  const error = useSignal<string | null>(null);
  const outcome = useSignal<"approved" | "denied" | null>(null);
  const action = useAction({ beforeReauth: () => writeStored(KEPT_CODE, code.value, "session") });

  useEffect(() => {
    if (!me.value) route(signInHref(path), true);
  }, [route, path]);

  async function find() {
    error.value = null;
    try {
      details.value = await api<DeviceDetails>(`/api/device/${encodeURIComponent(code.value.trim())}`);
    } catch (failure) {
      error.value = message(failure);
    }
  }
  async function lookUp(event: SubmitEvent) {
    event.preventDefault();
    await find();
  }
  useEffect(() => {
    forgetStored(KEPT_CODE, "session");
    // Only a kept code: this can run after the first keystroke, and what's being typed waits for Continue.
    if (kept) find();
  }, []);

  const decide = (kind: "approve" | "deny") =>
    action.run(async () => {
      await post(`/api/device/${encodeURIComponent(code.value.trim())}/${kind}`);
      outcome.value = kind === "approve" ? "approved" : "denied";
    });

  if (outcome.value) {
    return (
      <main class="screen">
        <h1 class="h1 m center">{outcome.value === "approved" ? "Approved" : "Denied"}</h1>
        <p class="sub center">
          {outcome.value === "approved"
            ? "Go back to your terminal. You can close this page."
            : "The CLI wasn't signed in."}
        </p>
      </main>
    );
  }

  if (!details.value) {
    return (
      <main class="screen">
        <div class="center">
          <Terminal size={40} />
        </div>
        <div class="center">
          <h1 class="h1 m">Approve the CLI</h1>
          <p class="sub">Type the code from your terminal.</p>
        </div>
        <form style="display:flex;flex-direction:column;gap:16px" onSubmit={lookUp}>
          <input
            class="field mono center"
            aria-label="Code"
            autocapitalize="characters"
            autocomplete="off"
            spellcheck={false}
            placeholder="WDJB-MJHT"
            value={code.value}
            onInput={(e) => {
              code.value = e.currentTarget.value;
            }}
          />
          {error.value && <p class="err">{error.value}</p>}
          <button class="btn ink" type="submit">
            Continue
          </button>
        </form>
      </main>
    );
  }

  return (
    <main class="screen">
      <div class="center">
        <Terminal size={40} />
      </div>
      <div class="center">
        <h1 class="h1 m">Approve the CLI?</h1>
        <p class="sub">Check this matches the code in your terminal.</p>
      </div>
      <div class="card code">{code.value.trim().toUpperCase()}</div>
      <div class="group">
        <div class="li">
          <Laptop />
          <div class="grow">
            <div class="tt">{details.value.clientName}</div>
            <div class="ss">
              {details.value.agent ? `From ${details.value.agent}` : "From artifacts login"}
              {details.value.ip ? `, ${details.value.ip}` : ""}
            </div>
          </div>
        </div>
        <div class="li">
          <Lock />
          <div class="grow">
            <div class="tt">Can publish and comment as {me.value?.name}</div>
            <div class="ss">Can't resolve threads, approve versions or delete anything for good</div>
          </div>
        </div>
      </div>
      {action.error.value && <p class="err">{action.error.value}</p>}
      <div class="spacer" />
      <button type="button" class="btn ink" onClick={() => decide("approve")}>
        Approve
      </button>
      <button type="button" class="btn" onClick={() => decide("deny")}>
        Deny
      </button>
      {action.sheet}
    </main>
  );
}
