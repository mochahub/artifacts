import { and, eq } from "drizzle-orm";
import { oauthClients } from "../db/schema.ts";
import type { Deps } from "../deps.ts";

const METADATA_HOURS = 1;

type Client = { clientId: string; name: string; redirectUris: string[] };

const isLoopbackHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** Redirects are https, or http to this machine, with no fragment (MCP authorization, "Communication"). */
export function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 2000) return false;
  try {
    const url = new URL(uri);
    if (url.hash || url.username || url.password) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
  } catch {
    return false;
  }
}

/** Exact, except that a native app's loopback port is chosen at run time (RFC 8252 7.3). */
export function redirectAllowed(registered: string[], requested: string) {
  if (registered.includes(requested)) return true;
  if (!validRedirect(requested)) return false;
  const wanted = new URL(requested);
  if (wanted.protocol !== "http:") return false;
  return registered.some((entry) => {
    const url = new URL(entry);
    return (
      url.protocol === "http:" &&
      url.hostname === wanted.hostname &&
      url.pathname === wanted.pathname &&
      url.search === wanted.search
    );
  });
}

/** A client_id that's a URL we may fetch: https, a path, and nothing that hides where it goes. */
export function metadataUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.pathname === "/" || url.hash || url.username || url.password) {
      return null;
    }
    if (url.port && url.port !== "443") return null;
    return url;
  } catch {
    return null;
  }
}

function parseMetadata(url: URL, body: unknown): Client | null {
  const document = body as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown };
  // The document names itself, so a page can't speak for another client (spec: MUST match exactly).
  if (document?.client_id !== url.href && document?.client_id !== url.toString()) return null;
  if (typeof document.client_name !== "string" || !document.client_name.trim()) return null;
  const uris = document.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 20 || !uris.every(validRedirect))
    return null;
  return { clientId: url.toString(), name: document.client_name.trim().slice(0, 100), redirectUris: uris };
}

/** A registered client, or a metadata document, fetched at most once an hour. */
export async function findClient(deps: Deps, orgId: string, clientId: string): Promise<Client | null> {
  if (clientId.length > 500) return null;
  const [row] = await deps.db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.orgId, orgId), eq(oauthClients.clientId, clientId)))
    .limit(1);
  const url = metadataUrl(clientId);
  if (!url) return row ? { clientId, name: row.name, redirectUris: row.redirectUris } : null;
  const now = deps.clock.now();
  if (row?.fetchedAt && now.getTime() - row.fetchedAt.getTime() < METADATA_HOURS * 3600_000) {
    return { clientId, name: row.name, redirectUris: row.redirectUris };
  }
  const client = await deps
    .clientMetadata(url)
    .then((body) => parseMetadata(url, body))
    .catch(() => null);
  if (!client) return null;
  await deps.db
    .insert(oauthClients)
    .values({
      id: Bun.randomUUIDv7(),
      orgId,
      clientId,
      name: client.name,
      redirectUris: client.redirectUris,
      metadataUrl: true,
      createdAt: now,
      fetchedAt: now,
    })
    .onConflictDoUpdate({
      target: [oauthClients.orgId, oauthClients.clientId],
      set: { name: client.name, redirectUris: client.redirectUris, fetchedAt: now },
    });
  return client;
}
