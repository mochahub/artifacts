import { signal } from "@preact/signals";
import { api, del, post } from "./api.ts";
import { readStored, writeStored } from "./storage.ts";

/** Set after a first comment; the app shows the sheet. */
export const askInstall = signal(false);

const ASKED = "artifacts.install-asked";

export const standalone = () =>
  matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
const iPhone = () => /iPhone|iPad/.test(navigator.userAgent);
export const canPush = () => "PushManager" in window && "serviceWorker" in navigator;

/** iPhone only sends web notifications to sites on the Home Screen, so Safari has to install first. */
export const needsInstall = () => iPhone() && !standalone();

/** Asked once, after your first comment (06). */
export function shouldAsk() {
  if (readStored(ASKED)) return false;
  if (!needsInstall() && (!canPush() || Notification.permission !== "default")) return false;
  writeStored(ASKED, "1");
  return true;
}

const keyBytes = (key: string) =>
  Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));

export async function currentSubscription() {
  if (!canPush()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export async function turnOnNotifications() {
  if ((await Notification.requestPermission()) !== "granted") return false;
  const registration = await navigator.serviceWorker.ready;
  const { key } = await api<{ key: string }>("/api/push/key");
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(key),
  });
  const { endpoint, keys } = subscription.toJSON();
  await post("/api/push/subscribe", { endpoint, keys });
  return true;
}

export async function turnOffNotifications() {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await del("/api/push/subscribe", { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

/** Kept pages and answers belong to whoever was signed in. From here too: this page may not be controlled. */
export async function clearOffline() {
  await Promise.all(["api-v1", "content-v1"].map((name) => caches.delete(name))).catch(() => {});
}
