import { useSignal } from "@preact/signals";
import { message } from "../api.ts";
import { needsInstall, turnOnNotifications } from "../notify.ts";
import { Sheet } from "./sheets.tsx";

/** Board 05, screen 6. On iPhone it explains installing; once installed it asks for alerts. */
export function InstallSheet({ onClose }: { onClose(): void }) {
  const error = useSignal<string | null>(null);
  const install = needsInstall();
  return (
    <Sheet title="Get notified when an agent replies" onClose={onClose}>
      {install ? (
        <>
          <p class="sub">iPhone only sends web notifications to apps on your Home Screen.</p>
          <ol class="steps">
            <li>Tap More, then Share</li>
            <li>Add to Home Screen</li>
            <li>Open it and allow alerts</li>
          </ol>
        </>
      ) : (
        <p class="sub">Your own server sends these. No other account is involved.</p>
      )}
      {error.value && <p class="err">{error.value}</p>}
      {!install && (
        <button
          type="button"
          class="btn ink"
          onClick={async () => {
            try {
              await turnOnNotifications();
              onClose();
            } catch (failure) {
              error.value = message(failure);
            }
          }}
        >
          Turn on notifications
        </button>
      )}
      <button type="button" class="btn soft" onClick={onClose}>
        Not now
      </button>
    </Sheet>
  );
}
