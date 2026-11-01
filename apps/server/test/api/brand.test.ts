import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BrandProposal, OrgBrand } from "@artifacts/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { brandProposals, org } from "../../src/db/schema.ts";
import { claim, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { makePerson } from "../publish-helper.ts";

describe("setting a brand by hand", () => {
  let t: TestServer;
  let cookie: string;
  let token: string;
  let orgId: string;
  const put = (json: unknown, auth: { cookie?: string; bearer?: string } = { cookie }) =>
    t.api("/api/brand", { method: "PUT", json, ...auth });
  const current = async () => OrgBrand.parse(await (await t.api("/api/brand", { cookie })).json()).brand;
  const list = async () =>
    z.array(BrandProposal).parse(await (await t.api("/api/brand/proposals", { cookie })).json());
  const row = async (name: string) => (await list()).find((entry) => entry.name === name);
  const acme = { name: "Acme", theme: { accent: "#d2452d", font: "humanist", radius: 10 } };

  beforeAll(async () => {
    t = await startTestServer();
    const owner = await claim(t);
    token = owner.token;
    orgId = (await t.server.db.select().from(org))[0]?.id as string;
    cookie = await signIn(t, OWNER.email, OWNER.password);
  });
  afterAll(() => t.stop());

  test("saving applies it and lists it as the current brand, with no sample", async () => {
    expect((await put(acme)).status).toBe(200);
    expect(await current()).toEqual({ ...acme, fonts: [] });
    expect(await row("Acme")).toMatchObject({ sample: null, agent: null, current: true });
  });

  test("saving a name again replaces it instead of adding another", async () => {
    await put({ ...acme, theme: { ...acme.theme, accent: "#123456" } });
    expect((await list()).filter((entry) => entry.name === "Acme")).toHaveLength(1);
    expect((await current())?.theme.accent).toBe("#123456");
  });

  test("an earlier brand can be applied again, and only the live one is current", async () => {
    await put({ name: "Other", theme: { accent: "#00a36c" } });
    expect((await row("Acme"))?.current).toBe(false);
    expect((await row("Other"))?.current).toBe(true);
    const apply = `/api/brand/proposals/${(await row("Acme"))?.id}/apply`;
    expect((await t.api(apply, { method: "POST", cookie })).status).toBe(200);
    expect((await current())?.name).toBe("Acme");
    expect((await row("Acme"))?.current).toBe(true);
    expect((await row("Other"))?.current).toBe(false);
  });

  test("going back to the default leaves nothing current, and nothing lost", async () => {
    await t.api("/api/brand", { method: "DELETE", cookie });
    expect(await current()).toBe(null);
    expect((await list()).map((entry) => entry.current)).toEqual([false, false]);
    const apply = `/api/brand/proposals/${(await row("Other"))?.id}/apply`;
    expect((await t.api(apply, { method: "POST", cookie })).status).toBe(200);
    expect((await current())?.name).toBe("Other");
  });

  test("it can't name a blob, and a font must be one we have", async () => {
    const hash = "a".repeat(64);
    const font = { family: "Stolen", weight: "400", format: "woff2", hash };
    expect((await put({ ...acme, fonts: [font] })).status).toBe(400);
    expect((await put({ name: "Bad", theme: { font: "Stolen" } })).status).toBe(400);
    expect((await put({ name: "Bad", theme: { accent: "red" } })).status).toBe(400);
    expect(await row("Bad")).toBeUndefined();
  });

  test("fonts in use stay when a brand is edited, and go when it stops using them", async () => {
    const hash = "b".repeat(64);
    const font = { family: "Acme Sans", weight: "400", style: "normal", format: "woff2", hash };
    await t.server.db
      .update(org)
      .set({ brand: { name: "Fonts", theme: { font: "Acme Sans" }, fonts: [font] } })
      .where(eq(org.id, orgId));
    expect((await put({ name: "Fonts", theme: { font: "Acme Sans", accent: "#111111" } })).status).toBe(200);
    expect((await current())?.fonts.map((entry) => entry.hash)).toEqual([hash]);
    expect((await put({ name: "Fonts", theme: { font: "serif" } })).status).toBe(200);
    expect((await current())?.fonts).toEqual([]);
    expect((await put({ name: "Fonts", theme: { font: "Acme Sans" } })).status).toBe(400);
  });

  test("only a signed-in admin can, and no token", async () => {
    const before = await t.server.db.select().from(brandProposals).where(eq(brandProposals.orgId, orgId));
    expect((await put(acme, { bearer: token })).status).toBe(403);
    expect((await put(acme, { bearer: await makePerson(t, orgId, "member") })).status).toBe(403);
    expect((await put(acme, {})).status).toBe(401);
    expect(await t.server.db.select().from(brandProposals).where(eq(brandProposals.orgId, orgId))).toEqual(
      before,
    );
  });
});
