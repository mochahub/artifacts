import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactAccess } from "@artifacts/schema";
import { OWNER, signIn, type TestServer } from "../../../apps/server/test/helpers.ts";
import { artifactAt, cli, cliJson, copyFixture, fixture, hostedServer, sandbox } from "./sandbox.ts";

/** What an agent can do about teams: read them, and share its own work with one, up to comment. */
describe("teams from the CLI", () => {
  let t: TestServer;
  let url: string;
  let token: string;
  let cookie: string;
  let ownerId: string;
  let fixtureDir: string | undefined;
  const box = sandbox();
  const agent = () => ({ ...box.env, ARTIFACTS_URL: url, ARTIFACTS_TOKEN: token });

  beforeAll(async () => {
    let person: { id: string };
    ({ t, url, token, person } = await hostedServer());
    ownerId = person.id;
    cookie = await signIn(t, OWNER.email, OWNER.password);
  });
  afterAll(async () => {
    await t.stop();
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("list teams, share with one, and be refused what a person must do", async () => {
    const empty = await cli(["teams"], agent());
    expect(empty.stdout).toContain("No teams yet");
    const made = await t.api("/api/teams", { method: "POST", cookie, json: { name: "Design" } });
    expect(made.status).toBe(200);
    const { team } = (await made.json()) as { team: { id: string; slug: string } };
    const joined = await t.api(`/api/teams/${team.slug}/members/${ownerId}`, {
      method: "PUT",
      cookie,
      json: { role: "lead" },
    });
    expect(joined.status).toBe(200);

    const listed = await cliJson(["teams"], agent());
    expect(listed.teams).toEqual([expect.objectContaining({ slug: "design", members: 1, role: "lead" })]);
    expect((await cli(["teams"], agent())).stdout).toContain("you lead it");

    // Team grants and audience output do not depend on the 26 CameraBuddy frames.
    // Keep real CLI/server publish boundaries with one frame and an article instead.
    const dir = copyFixture(fixture("small"));
    fixtureDir = dir;
    const path = join(dir, "artifact.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...manifest, project: "camerabuddy", slug: "roadmap" }));
    expect((await cli(["publish", "-m", "First"], agent(), dir)).code).toBe(0);
    const { id } = await artifactAt(t, token, "camerabuddy/roadmap");

    const shared = await cliJson(["share", "--team", "design", "--comment"], agent(), dir);
    expect(shared).toEqual({ team: "design", permission: "comment" });
    // The Share sheet shows the grant, marked as a token's until a person confirms it.
    const access = ArtifactAccess.parse(
      await (await t.api(`/api/artifacts/${id}/access`, { cookie })).json(),
    );
    expect(access.teams).toEqual([
      expect.objectContaining({ slug: "design", permission: "comment", viaToken: true }),
    ]);

    expect((await cli(["share", "--team", "design", "--publish"], agent(), dir)).code).toBe(2);
    expect((await cli(["share", "--team", "../people"], agent(), dir)).code).toBe(2);
    const missing = await cli(["share", "--team", "nobody"], agent(), dir);
    expect(missing.code).toBe(1);

    // Tokens read a project's access, and say who can see what they publish.
    const project = await cliJson(["project", "access"], agent(), dir);
    expect(project.project).toMatchObject({ slug: "camerabuddy", restricted: false });
    expect((await cli(["project", "access"], agent(), dir)).stdout).toContain("open to the organization");
    expect((await cli(["project", "nonsense"], agent(), dir)).code).toBe(2);
    const again = await cli(["publish", "-m", "Second"], agent(), dir);
    expect(again.stdout + again.stderr).toContain("visible to  Everyone in Mochahub");
    const status = await cliJson(["status"], agent(), dir);
    expect(status.audience).toBe("Everyone in Mochahub");
  }, 120_000);
});
