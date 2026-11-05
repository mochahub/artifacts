import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { artifacts, artifactTeamAccess, people } from "../../../apps/server/src/db/schema.ts";
import {
  OWNER,
  signIn,
  startTestServer,
  type TestServer,
  testPort,
} from "../../../apps/server/test/helpers.ts";
import { camerabuddy, cli, copyFixture, sandbox } from "./sandbox.ts";

/** What an agent can do about teams: read them, and share its own work with one, up to comment. */
describe("teams from the CLI", () => {
  let t: TestServer;
  let url: string;
  let token: string;
  let cookie: string;
  const box = sandbox();
  const agent = () => ({ ...box.env, ARTIFACTS_URL: url, ARTIFACTS_TOKEN: token });

  beforeAll(async () => {
    const port = testPort();
    url = `http://127.0.0.1:${port}`;
    t = await startTestServer({ PUBLIC_URL: url, MORE_URLS: "", PORT: String(port) });
    const setup = await t.api("/api/setup", {
      method: "POST",
      json: { setupToken: "s".repeat(48), orgName: "Mochahub", clientName: "x", ...OWNER },
    });
    token = ((await setup.json()) as { token: string }).token;
    cookie = await signIn(t, OWNER.email, OWNER.password);
  });
  afterAll(() => t.stop());

  test("list teams, share with one, and be refused what a person must do", async () => {
    const empty = await cli(["teams"], agent());
    expect(empty.stdout).toContain("No teams yet");
    const made = await t.api("/api/teams", { method: "POST", cookie, json: { name: "Design" } });
    const { team } = (await made.json()) as { team: { id: string; slug: string } };
    const [me] = await t.server.db.select().from(people).limit(1);
    await t.api(`/api/teams/${team.slug}/members/${me?.id}`, {
      method: "PUT",
      cookie,
      json: { role: "lead" },
    });

    const listed = JSON.parse((await cli(["teams", "--json"], agent())).stdout);
    expect(listed.teams).toEqual([expect.objectContaining({ slug: "design", members: 1, role: "lead" })]);
    expect((await cli(["teams"], agent())).stdout).toContain("you lead it");

    const dir = copyFixture(camerabuddy);
    expect((await cli(["publish", "-m", "First"], agent(), dir)).code).toBe(0);
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "roadmap"));

    const shared = await cli(["share", "--team", "design", "--comment", "--json"], agent(), dir);
    expect(JSON.parse(shared.stdout)).toEqual({ team: "design", permission: "comment" });
    const [grant] = await t.server.db
      .select()
      .from(artifactTeamAccess)
      .where(eq(artifactTeamAccess.artifactId, row?.id as string));
    expect(grant).toMatchObject({ permission: "comment", viaToken: true });

    expect((await cli(["share", "--team", "design", "--publish"], agent(), dir)).code).toBe(2);
    expect((await cli(["share", "--team", "../people"], agent(), dir)).code).toBe(2);
    const missing = await cli(["share", "--team", "nobody"], agent(), dir);
    expect(missing.code).toBe(1);

    // Tokens read a project's access, and say who can see what they publish.
    const access = JSON.parse((await cli(["project", "access", "--json"], agent(), dir)).stdout);
    expect(access.project).toMatchObject({ slug: "camerabuddy", restricted: false });
    expect((await cli(["project", "access"], agent(), dir)).stdout).toContain("open to the organization");
    expect((await cli(["project", "nonsense"], agent(), dir)).code).toBe(2);
    const again = await cli(["publish", "-m", "Second"], agent(), dir);
    expect(again.stdout + again.stderr).toContain("visible to  Everyone in Mochahub");
    const status = JSON.parse((await cli(["status", "--json"], agent(), dir)).stdout);
    expect(status.audience).toBe("Everyone in Mochahub");
  }, 120_000);
});
