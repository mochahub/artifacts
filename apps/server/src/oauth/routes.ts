import { createHash, timingSafeEqual } from "node:crypto";
import { type OAuthConsent, OAuthConsentDecision } from "@artifacts/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import type { Deps } from "../api/deps.ts";
import { parseBody, type Routes } from "../api/routes.ts";
import { newApiToken, randomSecret, sha256 } from "../auth/secrets.ts";
import { findOrg } from "../db/index.ts";
import { oauthClients, oauthCodes, oauthGrants, oauthRefreshTokens, tokens } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { findClient, redirectAllowed, validRedirect } from "./clients.ts";
import { MCP_PATH, OAUTH_SCOPES, requestOrigin } from "./origin.ts";

const CODE_MINUTES = 5;
const ACCESS_SECONDS = 3600;
const REFRESH_DAYS = 60;
const HOUR = 3600_000;

/** Answers from the token endpoint are JSON with these exact shapes (RFC 6749 5.2). */
const oauthError = (c: Context, error: string, description: string, status: 400 | 401 = 400) =>
  c.json({ error, error_description: description }, status, { "Cache-Control": "no-store" });

const parseScopes = (scope: string | undefined): string[] | null => {
  const words = (scope ?? "").split(/\s+/).filter(Boolean);
  // A client can ask for refresh this way. It's implied, and not a permission.
  const wanted = words.filter((word) => word !== "offline_access");
  if (wanted.some((word) => !(OAUTH_SCOPES as readonly string[]).includes(word))) return null;
  return wanted.length > 0 ? [...new Set(wanted)] : [...OAUTH_SCOPES];
};

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

function sameText(a: string, b: string) {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What an authorization request must be before anyone is shown a consent screen. */
async function checkRequest(
  deps: Deps,
  orgId: string,
  origin: string,
  query: Record<string, string | undefined>,
) {
  const client = query.client_id ? await findClient(deps, orgId, query.client_id) : null;
  // These two never redirect: a redirect to an unchecked address is how an open redirect starts.
  if (!client) throw new ApiError("invalid", "This client isn't known.");
  const redirectUri = query.redirect_uri ?? "";
  if (!redirectAllowed(client.redirectUris, redirectUri)) {
    throw new ApiError("invalid", "This redirect address isn't registered for the client.");
  }
  const scopes = parseScopes(query.scope);
  const problem =
    query.response_type !== "code"
      ? ["unsupported_response_type", "Only code is supported."]
      : !query.code_challenge || query.code_challenge_method !== "S256"
        ? ["invalid_request", "PKCE with S256 is required."]
        : !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge)
          ? ["invalid_request", "That code_challenge isn't an S256 challenge."]
          : query.resource !== `${origin}${MCP_PATH}`
            ? ["invalid_target", "The resource must be this server's MCP endpoint."]
            : !scopes
              ? ["invalid_scope", "Scopes are read, comment and publish."]
              : null;
  return { client, redirectUri, scopes: scopes ?? [], problem, state: query.state };
}

/** Where the browser goes next, always with `iss`, so a client can't be mixed up (RFC 9207). */
function redirectTo(uri: string, origin: string, params: Record<string, string | undefined>) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  url.searchParams.set("iss", origin);
  return url.toString();
}

/** Ends a grant and everything issued from it. Replaying a used code or refresh token does this too. */
export async function revokeGrant(deps: Pick<Deps, "db" | "clock">, grantId: string) {
  const now = deps.clock.now();
  await deps.db.update(oauthGrants).set({ revokedAt: now }).where(eq(oauthGrants.id, grantId));
  await deps.db
    .update(tokens)
    .set({ revokedAt: now })
    .where(and(eq(tokens.grantId, grantId), isNull(tokens.revokedAt)));
}

async function issueTokens(deps: Deps, grant: typeof oauthGrants.$inferSelect) {
  const now = deps.clock.now();
  const access = newApiToken();
  const refresh = randomSecret();
  await deps.db.insert(tokens).values({
    id: Bun.randomUUIDv7(),
    orgId: grant.orgId,
    kind: "oauth",
    personId: grant.personId,
    name: grant.clientName,
    tokenHash: sha256(access),
    scopes: grant.scopes,
    createdBy: grant.personId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ACCESS_SECONDS * 1000),
    grantId: grant.id,
    audience: grant.audience,
  });
  await deps.db.insert(oauthRefreshTokens).values({
    id: Bun.randomUUIDv7(),
    orgId: grant.orgId,
    grantId: grant.id,
    tokenHash: sha256(refresh),
    createdAt: now,
    expiresAt: new Date(now.getTime() + REFRESH_DAYS * 24 * HOUR),
  });
  await deps.db.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, grant.id));
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_SECONDS,
    refresh_token: refresh,
    scope: grant.scopes.join(" "),
  };
}

async function form(c: Context) {
  const type = c.req.header("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return null;
  const body = await c.req.parseBody();
  return Object.fromEntries(
    Object.entries(body).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : [])),
  );
}

export function oauthRoutes(routes: Routes, deps: Deps) {
  const { db, clock, limits } = deps;

  routes.get("/api/oauth/authorize", { public: true }, async (c) => {
    limits.hit(`oauth-authorize:${deps.clientIp(c)}`, 60, 15 * 60_000);
    const origin = await requestOrigin(c, deps);
    if (!origin) throw new ApiError("misdirected", "This server doesn't answer on that host.");
    const query = c.req.query();
    const checked = await checkRequest(deps, c.get("org").id, origin, query);
    if (checked.problem) {
      const [error, description] = checked.problem as [string, string];
      return c.redirect(
        redirectTo(checked.redirectUri, origin, {
          error,
          error_description: description,
          state: checked.state,
        }),
      );
    }
    // The viewer's consent screen reads these, and checks them again when it's answered.
    return c.redirect(`/device/connect?${new URLSearchParams(query as Record<string, string>)}`);
  });

  /** What the consent screen shows. A client's name is its own claim, so the page marks it so. */
  routes.get("/api/oauth/consent", { action: "account.manage" }, async (c) => {
    const origin = (await requestOrigin(c, deps)) as string;
    const checked = await checkRequest(deps, c.get("org").id, origin, c.req.query());
    if (checked.problem) throw new ApiError("invalid", (checked.problem as string[])[1] as string);
    const redirect = new URL(checked.redirectUri);
    return c.json({
      client: checked.client.name,
      clientId: checked.client.clientId,
      redirectHost: redirect.host,
      local: redirect.protocol === "http:",
      scopes: checked.scopes,
      resource: origin,
    } satisfies OAuthConsent);
  });

  routes.post("/api/oauth/consent", { action: "account.manage", recentAuth: true }, async (c) => {
    const body = await parseBody(c, OAuthConsentDecision);
    const caller = c.get("caller");
    if (caller.kind !== "person") throw new ApiError("forbidden", "This needs a signed-in browser.");
    const orgId = c.get("org").id;
    const origin = (await requestOrigin(c, deps)) as string;
    const checked = await checkRequest(deps, orgId, origin, body.request);
    if (checked.problem) throw new ApiError("invalid", (checked.problem as string[])[1] as string);
    if (!body.approve) {
      return c.json({
        redirect: redirectTo(checked.redirectUri, origin, { error: "access_denied", state: checked.state }),
      });
    }
    const code = randomSecret();
    const now = clock.now();
    const grantId = Bun.randomUUIDv7();
    await db.transaction(async (tx) => {
      await tx.insert(oauthGrants).values({
        id: grantId,
        orgId,
        personId: caller.person.id,
        clientId: checked.client.clientId,
        clientName: checked.client.name,
        audience: `${origin}${MCP_PATH}`,
        scopes: checked.scopes,
        createdAt: now,
      });
      await tx.insert(oauthCodes).values({
        id: Bun.randomUUIDv7(),
        orgId,
        codeHash: sha256(code),
        grantId,
        clientId: checked.client.clientId,
        redirectUri: checked.redirectUri,
        codeChallenge: body.request.code_challenge as string,
        createdAt: now,
        expiresAt: new Date(now.getTime() + CODE_MINUTES * 60_000),
      });
    });
    return c.json({ redirect: redirectTo(checked.redirectUri, origin, { code, state: checked.state }) });
  });

  routes.post("/api/oauth/token", { public: true }, async (c) => {
    limits.hit(`oauth-token:${deps.clientIp(c)}`, 120, 15 * 60_000);
    const body = await form(c);
    if (!body) return oauthError(c, "invalid_request", "Send a form.");
    const origin = await requestOrigin(c, deps);
    const orgId = c.get("org").id;
    const audience = `${origin}${MCP_PATH}`;
    if (body.resource && body.resource !== audience) {
      return oauthError(c, "invalid_target", "The resource must be this server's MCP endpoint.");
    }
    if (body.grant_type === "authorization_code") {
      const [row] = await db
        .select()
        .from(oauthCodes)
        .where(and(eq(oauthCodes.orgId, orgId), eq(oauthCodes.codeHash, sha256(body.code ?? ""))))
        .limit(1);
      if (!row) return oauthError(c, "invalid_grant", "That code isn't valid.");
      // Only one exchange can win. A second means the code leaked, so what the first got ends too.
      const claimed = await db
        .update(oauthCodes)
        .set({ usedAt: clock.now() })
        .where(and(eq(oauthCodes.id, row.id), isNull(oauthCodes.usedAt)))
        .returning({ id: oauthCodes.id });
      if (claimed.length === 0) {
        await revokeGrant(deps, row.grantId);
        return oauthError(c, "invalid_grant", "That code was already used.");
      }
      const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, row.grantId)).limit(1);
      const good =
        grant &&
        !grant.revokedAt &&
        row.expiresAt > clock.now() &&
        row.clientId === body.client_id &&
        row.redirectUri === body.redirect_uri &&
        grant.audience === audience &&
        sameText(s256(body.code_verifier ?? ""), row.codeChallenge);
      if (!good) {
        await revokeGrant(deps, row.grantId);
        return oauthError(c, "invalid_grant", "That code doesn't match this request.");
      }
      return c.json(await issueTokens(deps, grant), 200, { "Cache-Control": "no-store" });
    }
    if (body.grant_type === "refresh_token") {
      const [row] = await db
        .select({ token: oauthRefreshTokens, grant: oauthGrants })
        .from(oauthRefreshTokens)
        .innerJoin(oauthGrants, eq(oauthGrants.id, oauthRefreshTokens.grantId))
        .where(
          and(
            eq(oauthRefreshTokens.orgId, orgId),
            eq(oauthRefreshTokens.tokenHash, sha256(body.refresh_token ?? "")),
          ),
        )
        .limit(1);
      if (!row) return oauthError(c, "invalid_grant", "That refresh token isn't valid.");
      const { token, grant } = row;
      if (grant.clientId !== body.client_id || grant.audience !== audience) {
        return oauthError(c, "invalid_grant", "That refresh token isn't for this client.");
      }
      const claimed = await db
        .update(oauthRefreshTokens)
        .set({ usedAt: clock.now() })
        .where(and(eq(oauthRefreshTokens.id, token.id), isNull(oauthRefreshTokens.usedAt)))
        .returning({ id: oauthRefreshTokens.id });
      if (claimed.length === 0) {
        // A rotated token came back: either side may hold a stolen copy, so neither keeps access.
        await revokeGrant(deps, grant.id);
        return oauthError(c, "invalid_grant", "That refresh token was already used.");
      }
      if (grant.revokedAt || token.expiresAt <= clock.now()) {
        return oauthError(c, "invalid_grant", "That refresh token has ended.");
      }
      return c.json(await issueTokens(deps, grant), 200, { "Cache-Control": "no-store" });
    }
    return oauthError(c, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  });

  /** RFC 7009: the same answer for a token that exists and one that doesn't. */
  routes.post("/api/oauth/revoke", { public: true }, async (c) => {
    limits.hit(`oauth-token:${deps.clientIp(c)}`, 120, 15 * 60_000);
    const body = await form(c);
    if (!body?.token) return oauthError(c, "invalid_request", "Send a token.");
    const orgId = c.get("org").id;
    const hash = sha256(body.token);
    const [refresh] = await db
      .select({ grantId: oauthRefreshTokens.grantId })
      .from(oauthRefreshTokens)
      .where(and(eq(oauthRefreshTokens.orgId, orgId), eq(oauthRefreshTokens.tokenHash, hash)))
      .limit(1);
    if (refresh) await revokeGrant(deps, refresh.grantId);
    await db
      .update(tokens)
      .set({ revokedAt: clock.now() })
      .where(and(eq(tokens.orgId, orgId), eq(tokens.tokenHash, hash), eq(tokens.kind, "oauth")));
    return c.body(null, 200);
  });

  /** Deprecated by MCP but some clients still need it (RFC 7591). Public clients only. */
  routes.post("/api/oauth/register", { public: true }, async (c) => {
    limits.hit(`oauth-register:${deps.clientIp(c)}`, 20, HOUR);
    const body = (await c.req.json().catch(() => null)) as {
      client_name?: unknown;
      redirect_uris?: unknown;
    } | null;
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 20 || !uris.every(validRedirect)) {
      return c.json(
        { error: "invalid_redirect_uri", error_description: "Use https, or http on this machine." },
        400,
      );
    }
    const name =
      typeof body?.client_name === "string" && body.client_name.trim()
        ? body.client_name.trim().slice(0, 100)
        : "Unnamed connector";
    const clientId = `art_client_${randomSecret()}`;
    await db.insert(oauthClients).values({
      id: Bun.randomUUIDv7(),
      orgId: c.get("org").id,
      clientId,
      name,
      redirectUris: uris,
      createdAt: clock.now(),
    });
    return c.json(
      {
        client_id: clientId,
        client_name: name,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
      { "Cache-Control": "no-store" },
    );
  });

  /** Both are public, and differ per origin: issuer and resource are the domain the client used. */
  const metadata = (build: (origin: string) => object) => async (c: Context) => {
    const org = await findOrg(deps.db);
    const origin = await requestOrigin(c, deps);
    if (!org || !origin) throw new ApiError("not_found", "Not found.");
    return c.json(build(origin), 200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    });
  };
  const resource = metadata((origin) => ({
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [origin],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ["header"],
  }));
  routes.get("/.well-known/oauth-protected-resource/api/mcp", { public: true }, resource);
  routes.get("/.well-known/oauth-protected-resource", { public: true }, resource);
  routes.get(
    "/.well-known/oauth-authorization-server",
    { public: true },
    metadata((origin) => ({
      issuer: origin,
      authorization_endpoint: `${origin}/api/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      revocation_endpoint: `${origin}/api/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...OAUTH_SCOPES, "offline_access"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    })),
  );
}
