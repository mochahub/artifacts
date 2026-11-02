const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 10_000;
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export type GoogleExchange = {
  code: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
};

/** What we need from Google. Tests stand in for it, because tests never call Google. */
export type GoogleProvider = {
  authorizeUrl: string;
  /** Swaps a code for an ID token, or throws. */
  exchange(input: GoogleExchange): Promise<string>;
};

export const googleProvider: GoogleProvider = {
  authorizeUrl: AUTHORIZE_URL,
  async exchange({ code, verifier, redirectUri, clientId, clientSecret }) {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const body = (await response.json().catch(() => null)) as { id_token?: unknown; error?: unknown } | null;
    if (!response.ok) {
      // Only Google's own word for it, such as redirect_uri_mismatch: this ends up in the logs.
      const reason = typeof body?.error === "string" ? ` ${body.error.slice(0, 80)}` : "";
      throw new Error(`Google answered ${response.status}${reason}`);
    }
    if (typeof body?.id_token !== "string") throw new Error("Google sent no ID token");
    return body.id_token;
  },
};

export type GoogleClaims = {
  sub: string;
  email: string;
  name: string | null;
  /** The Workspace domain, from the claim. Never from a request parameter. */
  hostedDomain: string | null;
  emailVerified: boolean;
};

/**
 * Reads an ID token that came straight from Google's token endpoint over TLS, which OpenID Connect says
 * can stand in for checking its signature, so no JWT library is needed. Null if anything is off.
 */
export function readIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string; now: Date },
): GoogleClaims | null {
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString());
  } catch {
    return null;
  }
  const { iss, aud, azp, exp, nonce, sub, email, name, hd } = claims;
  if (typeof iss !== "string" || !ISSUERS.includes(iss)) return null;
  if (aud !== expected.clientId || (azp !== undefined && azp !== expected.clientId)) return null;
  if (typeof exp !== "number" || exp * 1000 <= expected.now.getTime()) return null;
  if (nonce !== expected.nonce) return null;
  if (typeof sub !== "string" || sub === "" || typeof email !== "string" || email === "") return null;
  return {
    sub,
    email,
    name: typeof name === "string" && name.trim() ? name.trim() : null,
    hostedDomain: typeof hd === "string" && hd ? hd.toLowerCase() : null,
    // Google's token info endpoint spells this as a string, so don't depend on which one comes back.
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
  };
}
