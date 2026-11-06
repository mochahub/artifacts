import { type Permission, type Role, type TokenScope, UNNAMED_AGENT } from "@artifacts/schema";
import type { OrgRow } from "../db/index.ts";

export type CallerPerson = { id: string; name: string; email: string; role: Role };

/** A guest's standing on one share link. `active` is false once the link is revoked or expired (04). */
export type GuestLink = {
  artifactId: string;
  shareLinkId: string;
  permission: Permission;
  name: string;
  active: boolean;
};

/** Who is asking. Every request resolves to exactly one of these (04, "Callers"). */
export type Caller =
  | { kind: "person"; person: CallerPerson; sessionId: string; recentAuth: boolean }
  | { kind: "cliToken"; person: CallerPerson; tokenId: string; scopes: TokenScope[] }
  | {
      kind: "orgToken";
      tokenId: string;
      createdBy: string;
      scopes: TokenScope[];
      projectIds: string[] | null;
    }
  | { kind: "guest"; guestId: string; links: GuestLink[] }
  | {
      kind: "content";
      artifactId: string;
      version: number;
      caller: {
        kind: "person" | "guest";
        id: string;
        name: string;
        canComment: boolean;
        isPublisher: boolean;
      };
    }
  | { kind: "anonymous" };

/** Who is asking, and in which organization: what a service needs from a request, API or MCP alike. */
export type Asker<C extends Caller = Caller> = { org: OrgRow; caller: C };

/** Whose views and replies a list reads: a person (also through their CLI token) or a guest. */
export const viewerId = (caller: Caller) =>
  caller.kind === "person" || caller.kind === "cliToken"
    ? { person: caller.person.id }
    : caller.kind === "guest"
      ? { guest: caller.guestId }
      : {};

/** The person or guest behind a caller, for rate limits and pseudonyms; null for organization tokens. */
export const callerKey = (caller: Caller): string | null => {
  if (caller.kind === "person" || caller.kind === "cliToken") return caller.person.id;
  if (caller.kind === "guest") return caller.guestId;
  if (caller.kind === "content") return caller.caller.id;
  return null;
};

/** The person an action is recorded against. An organization token acts for whoever made it (04). */
export const actorOf = (caller: Extract<Caller, { kind: "person" | "cliToken" | "orgToken" }>) =>
  caller.kind === "orgToken" ? caller.createdBy : caller.person.id;

/** Whose rate limit a request counts against: a person or a guest, or else the token itself. */
export const limiterKey = (caller: Caller): string | null =>
  callerKey(caller) ?? (caller.kind === "orgToken" ? caller.tokenId : null);

/**
 * Anything a token writes is marked as its agent's: the name the client sent, or `agent` if none. Only a
 * browser session writes as a person (04, "Agents are shown as agents").
 */
export const agentOf = (caller: Caller, sent: string | null | undefined) =>
  caller.kind === "cliToken" || caller.kind === "orgToken" ? sent?.trim() || UNNAMED_AGENT : null;
