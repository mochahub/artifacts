import type { GoogleOutcome } from "@artifacts/schema/constants";

/** Where a round trip through Google lands: the sign-in page, a Settings page, or the re-auth sheet. */
export type Landing = "sign-in" | "settings" | "reauth";

const TRY_AGAIN = "That took too long. Try again.";
const UNCONFIRMED = "Google didn't confirm it. Try again.";

/**
 * What each `?google=` answer (03) says where it lands, in the words of the flows in 04. Every answer is
 * listed, so one the server adds doesn't compile until it says something; one with nothing for a place
 * isn't shown there.
 */
const ANSWERS: Record<GoogleOutcome, Partial<Record<Landing, string>>> = {
  expired: { "sign-in": TRY_AGAIN, settings: TRY_AGAIN, reauth: UNCONFIRMED },
  off: { "sign-in": "Google sign-in is turned off here.", settings: "Google sign-in is turned off here." },
  cancelled: { "sign-in": "Google sign-in was cancelled.", settings: "Cancelled." },
  failed: {
    "sign-in": "Google sign-in didn't work. Try again.",
    settings: "Google didn't finish. Try again.",
    reauth: UNCONFIRMED,
  },
  unverified: {
    "sign-in": "Google hasn't verified that email address.",
    settings: "Google hasn't verified that email address.",
  },
  "link-first": { "sign-in": "Sign in once the usual way to connect Google." },
  "not-linked": { reauth: "Google isn't connected to your account. Use another way." },
  "no-account": { "sign-in": "Ask an admin for an invite." },
  "invite-mismatch": { "sign-in": "That Google account's email doesn't match the invite." },
  "invite-gone": { "sign-in": "That invite has expired or was already used. Ask for a new one." },
  "in-use": {
    "sign-in": "That Google account is already connected to someone here.",
    settings: "That Google account is already connected to someone here, or you have one connected.",
  },
  recent: { settings: "Sign in again, then connect Google." },
  mismatch: { settings: "That's a different Google account.", reauth: "That's a different Google account." },
  linked: { settings: "Google is connected." },
  confirmed: { settings: "Confirmed. Tap again to carry on." },
  tested: { settings: "That worked. You can turn Google on." },
};

export function googleAnswer(landing: Landing, outcome: string | null | undefined): string | null {
  if (!outcome || !Object.hasOwn(ANSWERS, outcome)) return null;
  return ANSWERS[outcome as GoogleOutcome][landing] ?? null;
}
