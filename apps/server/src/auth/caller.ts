import type { Permission, Role } from "@artifacts/schema";

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
  | { kind: "cliToken"; person: CallerPerson; tokenId: string; scopes: string[]; agent: string | null }
  | { kind: "orgToken"; tokenId: string; createdBy: string; scopes: string[]; projectIds: string[] | null }
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
