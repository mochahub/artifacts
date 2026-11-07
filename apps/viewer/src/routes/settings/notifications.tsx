import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { message } from "../../api.ts";
import {
  canPush,
  currentSubscription,
  needsInstall,
  turnOffNotifications,
  turnOnNotifications,
} from "../../notify.ts";
import { Frame } from "./frame.tsx";

export function Notifications() {
  const on = useSignal<boolean | null>(null);
  const error = useSignal<string | null>(null);
  useEffect(() => {
    currentSubscription().then((subscription) => {
      on.value = subscription !== null;
    });
  }, []);
  const change = async (work: () => Promise<unknown>) => {
    try {
      await work();
      on.value = (await currentSubscription()) !== null;
    } catch (failure) {
      error.value = message(failure);
    }
  };
  return (
    <Frame title="Notifications">
      {needsInstall() ? (
        <div class="empty">
          iPhone only sends web notifications to apps on your Home Screen. Add this site there first.
        </div>
      ) : !canPush() ? (
        <div class="empty">This browser can't receive notifications.</div>
      ) : (
        on.value !== null && (
          <>
            <div class="group">
              <div class="li">
                <div class="grow">
                  <div class="tt">{on.value ? "On for this device" : "Off for this device"}</div>
                  <div class="ss">When an agent publishes or someone replies, and a daily summary</div>
                </div>
              </div>
            </div>
            {error.value && <p class="err">{error.value}</p>}
            <button
              type="button"
              class="btn soft"
              onClick={() => change(on.value ? turnOffNotifications : turnOnNotifications)}
            >
              {on.value ? "Turn off" : "Turn on"}
            </button>
          </>
        )
      )}
    </Frame>
  );
}
