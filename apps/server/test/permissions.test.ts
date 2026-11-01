import { describe, expect, test } from "bun:test";
import type { Caller } from "../src/auth/caller.ts";
import { ACTIONS, type Action, type ArtifactResource, can } from "../src/auth/can.ts";

/**
 * The matrix in 04. `expected` below is written from 04's prose and deliberately knows nothing about
 * can(): it's a flat table per caller, so a change to either side shows up as a matrix diff.
 */
const PUBLISHER = "00000000-0000-7000-8000-00000000000a";
const OTHER = "00000000-0000-7000-8000-00000000000b";
const ADDED = "00000000-0000-7000-8000-00000000000c";
const OUTSIDE_ADDED = "00000000-0000-7000-8000-00000000000d";
const OUTSIDE_BY_TOKEN = "00000000-0000-7000-8000-000000000010";
const MEMBER_BY_TOKEN = "00000000-0000-7000-8000-000000000011";
const ARTIFACT = "00000000-0000-7000-8000-0000000000f0";
const PROJECT = "00000000-0000-7000-8000-0000000000e0";
const OTHER_PROJECT = "00000000-0000-7000-8000-0000000000e1";
const ALL_SCOPES = ["publish", "comment", "read", "manage", "data", "org"];
const CLI_SCOPES = ["publish", "comment", "read", "manage", "data"];

const person = (id: string, role: "owner" | "admin" | "member" | "reviewer" | "outside"): Caller => ({
  kind: "person",
  person: { id, name: "x", email: "x@example.com", role },
  sessionId: "s",
  recentAuth: true,
});
const guest = (permission: "view" | "comment", active: boolean): Caller => ({
  kind: "guest",
  guestId: "g",
  links: [{ artifactId: ARTIFACT, shareLinkId: "l", permission, name: "Guest", active }],
});
const orgToken = (projectIds: string[], scopes = ALL_SCOPES): Caller => ({
  kind: "orgToken",
  tokenId: "t",
  createdBy: OTHER,
  scopes,
  projectIds,
});

const cliToken = (
  id: string,
  role: "admin" | "reviewer" | "outside" | "member",
  scopes: string[],
): Caller => ({
  kind: "cliToken",
  tokenId: "t",
  agent: null,
  scopes,
  person: { id, name: "x", email: "x@example.com", role },
});

type Name = keyof typeof CALLERS;
const CALLERS = {
  owner: person(OTHER, "owner"),
  admin: person(OTHER, "admin"),
  "member (publisher)": person(PUBLISHER, "member"),
  "member (added with publish)": person(ADDED, "member"),
  "member (other)": person(OTHER, "member"),
  reviewer: person(OTHER, "reviewer"),
  "outside (added)": person(OUTSIDE_ADDED, "outside"),
  "outside (not added)": person(OTHER, "outside"),
  "outside (added by a token)": person(OUTSIDE_BY_TOKEN, "outside"),
  "member (added by a token)": person(MEMBER_BY_TOKEN, "member"),
  "guest (view link)": guest("view", true),
  "guest (comment link)": guest("comment", true),
  "guest (revoked link)": guest("comment", false),
  "cliToken (publisher)": {
    kind: "cliToken",
    tokenId: "t",
    agent: null,
    scopes: CLI_SCOPES,
    person: { id: PUBLISHER, name: "x", email: "x@example.com", role: "member" },
  },
  "cliToken (admin, not the publisher)": cliToken(OTHER, "admin", CLI_SCOPES),
  "cliToken (reviewer)": cliToken(OTHER, "reviewer", CLI_SCOPES),
  "cliToken (outside, added)": cliToken(OUTSIDE_ADDED, "outside", CLI_SCOPES),
  "cliToken (publisher, read only)": cliToken(PUBLISHER, "member", ["read"]),
  "orgToken (allowed project)": orgToken([PROJECT]),
  "orgToken (other project)": orgToken([OTHER_PROJECT]),
  "orgToken (no read scope)": orgToken(
    [PROJECT],
    ALL_SCOPES.filter((scope) => scope !== "read"),
  ),
  anonymous: { kind: "anonymous" },
} satisfies Record<string, Caller>;

const artifact = (visibility: "me" | "org", lifecycle: Lifecycle): ArtifactResource => ({
  type: "artifact",
  id: ARTIFACT,
  projectId: PROJECT,
  visibility,
  publisherId: PUBLISHER,
  archivedAt: lifecycle === "archived" ? new Date() : null,
  deletedAt: lifecycle === "deleted" ? new Date() : null,
  deletedBy: lifecycle === "deleted" ? PUBLISHER : null,
  access: [
    { personId: ADDED, permission: "publish", viaToken: false },
    { personId: OUTSIDE_ADDED, permission: "comment", viaToken: false },
    { personId: OUTSIDE_BY_TOKEN, permission: "comment", viaToken: true },
    { personId: MEMBER_BY_TOKEN, permission: "comment", viaToken: true },
  ],
});

type Lifecycle = "active" | "archived" | "deleted";
const ADMINS: Name[] = ["owner", "admin"];
const GUESTS_OK: Name[] = ["guest (view link)", "guest (comment link)"];

/** Who sees the artifact, ignoring deletion: the "Visibility first" table. */
function sees(name: Name, visibility: "me" | "org"): boolean {
  if (name === "member (publisher)" || name === "cliToken (publisher)") return true;
  if (name === "cliToken (publisher, read only)" || name === "cliToken (admin, not the publisher)")
    return true;
  if (ADMINS.includes(name) || name === "member (added with publish)" || name === "outside (added)")
    return true;
  if (name === "outside (added by a token)" || name === "member (added by a token)") return true;
  if (name === "cliToken (outside, added)") return true;
  if (GUESTS_OK.includes(name) || name === "guest (comment link)") return true;
  if (name === "member (other)" || name === "reviewer" || name === "cliToken (reviewer)")
    return visibility === "org";
  if (name === "orgToken (allowed project)") return visibility === "org";
  return false;
}

/** Comment rights on a visible, live artifact, before the archived rule. */
const commenters: Name[] = [
  "owner",
  "admin",
  "member (publisher)",
  "member (added with publish)",
  "member (other)",
  "reviewer",
  "outside (added)",
  "outside (added by a token)",
  "member (added by a token)",
  "guest (comment link)",
  "cliToken (publisher)",
  "cliToken (admin, not the publisher)",
  "cliToken (reviewer)",
  "cliToken (outside, added)",
];
const people: Name[] = [
  "owner",
  "admin",
  "member (publisher)",
  "member (added with publish)",
  "member (other)",
  "reviewer",
  "outside (added)",
  "outside (added by a token)",
  "member (added by a token)",
];
const publishers: Name[] = [
  "owner",
  "admin",
  "member (publisher)",
  "member (added with publish)",
  "cliToken (publisher)",
  "cliToken (admin, not the publisher)",
  "orgToken (allowed project)",
];
// A token manages only as the publisher (04), so an admin's token doesn't, whatever the admin may do.
const managers: Name[] = ["owner", "admin", "member (publisher)", "cliToken (publisher)"];
// The one place an admin's token acts as the admin on others' artifacts: "people or cliToken with data".
const exporters: Name[] = [...managers, "cliToken (admin, not the publisher)"];
const tokenAdmins: Name[] = ["cliToken (admin, not the publisher)"];

/**
 * Access a token granted lets someone comment but not decide or resolve, unless their role already lets
 * them comment: a member on an org-visible artifact. An outside person has only the row.
 */
function commentOnlyFromTokenGrant(name: Name, visibility: "me" | "org"): boolean {
  if (name === "outside (added by a token)") return true;
  return name === "member (added by a token)" && visibility === "me";
}

function expected(name: Name, action: Action, visibility: "me" | "org", lifecycle: Lifecycle): boolean {
  const seen = sees(name, visibility);
  const live = lifecycle !== "deleted";
  const unarchived = lifecycle === "active";
  const anyPerson = !name.startsWith("guest") && name !== "anonymous" && !name.startsWith("orgToken");
  const readOnly = name === "cliToken (publisher, read only)";
  switch (action) {
    case "home.read":
    case "project.list":
    case "project.read":
    case "brand.read":
      return anyPerson || (name.startsWith("orgToken") && name !== "orgToken (no read scope)");
    case "account.read":
      return anyPerson;
    case "account.manage":
      return anyPerson && !name.startsWith("cliToken");
    case "deleted.read":
      return anyPerson && !readOnly; // A token needs manage: agents can undelete, so they must find what they deleted.
    case "brand.propose":
      // As project.create, for people: an org token has nobody to answer for a proposal.
      return [
        "owner",
        "admin",
        "member (publisher)",
        "member (added with publish)",
        "member (other)",
        "member (added by a token)",
        "cliToken (publisher)",
        "cliToken (admin, not the publisher)",
      ].includes(name);
    case "project.create":
      // Members and up. A token also needs publish (cli) or org (org token); reviewers and outside people never.
      return (
        [
          "owner",
          "admin",
          "member (publisher)",
          "member (added with publish)",
          "member (other)",
          "member (added by a token)",
        ].includes(name) ||
        ["cliToken (publisher)", "cliToken (admin, not the publisher)"].includes(name) ||
        name.startsWith("orgToken")
      );
    case "artifact.read":
      return live && seen;
    case "data.read":
      return live && seen && !readOnly; // A token needs the data scope.
    case "artifact.comment":
    case "data.write":
      return unarchived && seen && commenters.includes(name);
    case "thread.resolve":
    case "artifact.decide":
      return (
        unarchived &&
        seen &&
        commenters.includes(name) &&
        people.includes(name) &&
        !commentOnlyFromTokenGrant(name, visibility)
      );
    case "artifact.publish":
      return unarchived && seen && publishers.includes(name);
    case "artifact.manage":
    case "artifact.share":
    case "artifact.archive":
      return live && seen && managers.includes(name);
    case "artifact.delete":
      return managers.includes(name); // The publisher deleted it in this table, so they and admins may undelete.
    case "artifact.purge":
      return ["owner", "admin", "member (publisher)"].includes(name);
    case "data.export":
      return live && seen && exporters.includes(name);
    case "org.read":
    case "people.read":
      return ADMINS.includes(name) || tokenAdmins.includes(name);
    case "org.manage":
    case "people.manage":
    case "tokens.manage":
    case "brand.apply":
      return ADMINS.includes(name); // People only.
    case "people.invite":
      return ADMINS.includes(name) || tokenAdmins.includes(name);
  }
}

describe("the permission matrix", () => {
  for (const name of Object.keys(CALLERS) as Name[]) {
    for (const visibility of ["me", "org"] as const) {
      for (const lifecycle of ["active", "archived", "deleted"] as const) {
        test(`${name}, ${visibility}, ${lifecycle}`, () => {
          const resource = artifact(visibility, lifecycle);
          const actual = Object.fromEntries(ACTIONS.map((a) => [a, can(CALLERS[name], a, resource)]));
          const want = Object.fromEntries(ACTIONS.map((a) => [a, expected(name, a, visibility, lifecycle)]));
          expect(actual).toEqual(want);
        });
      }
    }
  }
});

describe("rules the matrix can't express", () => {
  const live = artifact("org", "active");

  test("purging needs a recent sign-in", () => {
    const stale = { ...CALLERS.owner, recentAuth: false };
    expect(can(stale, "artifact.purge", live)).toBe(false);
  });

  test("a token never purges, resolves or decides, even for an owner", () => {
    const owner: Caller = {
      kind: "cliToken",
      tokenId: "t",
      agent: null,
      scopes: ALL_SCOPES,
      person: { id: OTHER, name: "x", email: "x@example.com", role: "owner" },
    };
    for (const action of ["artifact.purge", "thread.resolve", "artifact.decide"] as const) {
      expect(can(owner, action, live)).toBe(false);
    }
    expect(can(owner, "people.manage", { type: "org" })).toBe(false);
  });

  test("a token is limited to its scopes", () => {
    const readOnly: Caller = { ...CALLERS["cliToken (publisher)"], scopes: ["read"] };
    expect(can(readOnly, "artifact.read", live)).toBe(true);
    expect(can(readOnly, "artifact.comment", live)).toBe(false);
    expect(can(readOnly, "artifact.publish", live)).toBe(false);
    expect(can(readOnly, "artifact.archive", live)).toBe(false);
    expect(can(readOnly, "data.read", live)).toBe(false);
  });

  test("a member added with view can read a private artifact but not comment on it", () => {
    const viewer = artifact("me", "active");
    viewer.access = [{ personId: OTHER, permission: "view", viaToken: false }];
    expect(can(CALLERS["member (other)"], "artifact.read", viewer)).toBe(true);
    expect(can(CALLERS["member (other)"], "artifact.comment", viewer)).toBe(false);
  });

  test("a reviewer who once published never publishes", () => {
    const owned = artifact("org", "active");
    owned.publisherId = OTHER;
    expect(can(CALLERS.reviewer, "artifact.publish", owned)).toBe(false);
  });

  test("only the deleter and admins can bring a deleted artifact back", () => {
    const gone = artifact("org", "deleted");
    gone.deletedBy = OTHER;
    expect(can(CALLERS["member (publisher)"], "artifact.delete", gone)).toBe(false);
    expect(can(CALLERS.admin, "artifact.delete", gone)).toBe(true);
  });

  test("someone who deleted an artifact as an admin can't purge it once they're only a member", () => {
    const gone = artifact("org", "deleted");
    gone.deletedBy = OTHER;
    const formerAdmin = CALLERS["member (other)"];
    expect(can(formerAdmin, "artifact.purge", gone)).toBe(false);
    expect(can(formerAdmin, "artifact.delete", gone)).toBe(false);
    expect(can(CALLERS.admin, "artifact.purge", gone)).toBe(true);
  });

  test("a guest's rights stop at their own artifact", () => {
    const elsewhere = { ...live, id: "00000000-0000-7000-8000-0000000000f1" };
    expect(can(CALLERS["guest (comment link)"], "artifact.read", elsewhere)).toBe(false);
  });

  test("a content caller reads its artifact and writes only if it may comment", () => {
    const content = (canComment: boolean): Caller => ({
      kind: "content",
      artifactId: ARTIFACT,
      version: 1,
      caller: { kind: "person", id: OTHER, name: "x", canComment, isPublisher: false },
    });
    expect(can(content(false), "artifact.read", live)).toBe(true);
    expect(can(content(false), "data.write", live)).toBe(false);
    expect(can(content(true), "data.write", live)).toBe(true);
    expect(can(content(true), "data.write", artifact("org", "archived"))).toBe(false);
  });
});
