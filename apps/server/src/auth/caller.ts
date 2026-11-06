import type { Permission, Role, TokenScope } from "@artifacts/schema";

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
