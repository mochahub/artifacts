import type { Person } from "@artifacts/schema";
import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { post } from "./api.ts";
import { meta } from "./session.ts";

const onHome = () => location.hostname === meta.value?.homeDomain;

/** Whether this browser can use a passkey made for the home domain from here (04). */
export async function canUseHomePasskey(): Promise<boolean> {
  if (onHome()) return true;
  const capabilities = await (
    PublicKeyCredential as unknown as { getClientCapabilities?(): Promise<Record<string, boolean>> }
  ).getClientCapabilities?.();
  return capabilities?.relatedOrigins === true;
}

export async function assertion() {
  const local = !(await canUseHomePasskey());
  const options = await post<PublicKeyCredentialRequestOptionsJSON & { challengeId: string }>(
    "/api/auth/passkey/options",
    { local },
  );
  const response = await startAuthentication({ optionsJSON: options });
  return { challengeId: options.challengeId, response };
}

export async function signInWithPasskey() {
  const { person } = await post<{ person: Person }>("/api/auth/passkey/verify", await assertion());
  return person;
}

export async function addPasskey(name: string) {
  const local = !(await canUseHomePasskey());
  const options = await post<PublicKeyCredentialCreationOptionsJSON & { challengeId: string }>(
    "/api/me/passkeys/options",
    { local },
  );
  const response = await startRegistration({ optionsJSON: options });
  await post("/api/me/passkeys/verify", { challengeId: options.challengeId, response, name });
}

export const passkeyName = () => {
  const agent = navigator.userAgent;
  if (/iPhone|iPad/.test(agent)) return "iCloud Keychain";
  if (/Mac/.test(agent)) return "This Mac";
  return "Passkey";
};
