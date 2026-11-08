import { describe, expect, test } from "bun:test";
import type { Caller } from "../src/auth/caller.ts";
import type { ArtifactResource } from "../src/auth/can.ts";
import { ApiError } from "../src/http/errors.ts";
import { requireCan } from "../src/http/routes.ts";

const page: ArtifactResource = {
  type: "artifact",
  id: "page",
  projectId: "wiki",
  publisherId: "publisher",
  visibility: "org",
  archivedAt: null,
  deletedAt: null,
  deletedBy: null,
  access: [],
  inherited: [],
  restricted: false,
  projectTokenId: null,
  inWiki: true,
};
const token = (id = "publisher", scopes = ["read", "manage"]): Caller => ({
  kind: "cliToken",
  tokenId: "token",
  scopes: scopes as Extract<Caller, { kind: "cliToken" }>["scopes"],
  person: { id, role: "member", name: "Member", email: "member@example.com" },
});
function denied(
  caller: Caller,
  action: "artifact.edit" | "artifact.share" | "artifact.share_outside",
  resource = page,
) {
  try {
    requireCan(caller, action, resource);
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("Expected denial");
}

describe("actionable token denials", () => {
  test("edit recovery is offered only if adding scope grants permission", () => {
    expect(denied(token(), "artifact.edit").details).toEqual({ scope: "edit" });
    for (const scopes of [["read"], ["read", "edit"]]) {
      const error = denied(token("reader", scopes), "artifact.edit");
      expect(error.details).toEqual({});
      expect(error.message).not.toContain("Sign in again");
    }
  });
  test("publisher manage tokens retain open-project sharing and link authorization", () => {
    expect(() => requireCan(token(), "artifact.share", page)).not.toThrow();
    expect(() => requireCan(token(), "artifact.share_outside", page)).not.toThrow();
  });
  test("sharing denials describe missing permissions or restricted-project requirements", () => {
    for (const caller of [token("reader"), token("publisher", ["read"])]) {
      const error = denied(caller, "artifact.share");
      expect(error.message).toContain("manage scope and publisher rights");
      expect(error.message).not.toContain("Tokens cannot");
    }
    expect(denied(token(), "artifact.share_outside", { ...page, restricted: true }).message).toContain(
      "restricted project requires a person",
    );
    const org: Caller = {
      kind: "orgToken",
      tokenId: "org",
      createdBy: "publisher",
      projectIds: null,
      scopes: ["read", "manage"],
    };
    expect(denied(org, "artifact.share").code).toBe("forbidden");
  });
});
