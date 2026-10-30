import { useSignal } from "@preact/signals";
import { Check, Copy, KeyRound } from "lucide-preact";

export function AlmostReady() {
  const copied = useSignal(false);
  const command = `artifacts setup ${location.origin}`;
  return (
    <main class="screen">
      <div class="center">
        <span class="logo lg" />
      </div>
      <div class="center">
        <h1 class="h1 m">Almost ready</h1>
        <p class="sub">
          This deployment isn't set up yet. Claim it from your terminal to create your organization and its
          owner.
        </p>
      </div>
      <div class="term">
        <span class="p">$</span> {command}
      </div>
      <button
        type="button"
        class="btn soft"
        onClick={() => {
          navigator.clipboard?.writeText(command);
          copied.value = true;
        }}
      >
        {copied.value ? <Check /> : <Copy />}
        {copied.value ? "Copied" : "Copy command"}
      </button>
      <div class="spacer" />
      <div class="group">
        <div class="li">
          <KeyRound />
          <div class="grow">
            <div class="tt">Setup asks for a token</div>
            <div class="ss">Railway → Variables → SETUP_TOKEN, or it reads it with the Railway CLI</div>
          </div>
        </div>
      </div>
    </main>
  );
}
