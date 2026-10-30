import { randomBytes } from "node:crypto";
import { DEFAULT_ORG_SETTINGS, RecoverRequest, SetupRequest } from "@artifacts/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { randomSecret, safeEqual, sha256 } from "../auth/secrets.ts";
import { createCliToken, personView } from "../auth/sessions.ts";
import { findOrg } from "../db/index.ts";
import { activity, org, passwords, people, resetLinks } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import type { Deps } from "./deps.ts";
import { parseBody, type Routes } from "./routes.ts";

const SETUP_LOCK = 7_316_002;
const HOUR = 3600_000;

export function setupRoutes(routes: Routes, deps: Deps) {
  const { db, env, clock } = deps;

  routes.post("/api/setup", { public: true }, async (c) => {
    const body = await parseBody(c, SetupRequest);
    if (!safeEqual(body.setupToken, env.setupToken))
      throw new ApiError("forbidden", "That setup token is wrong.");
    if (await findOrg(db)) throw new ApiError("conflict", "This deployment is already set up.");

    const hash = await Bun.password.hash(body.password, { algorithm: "argon2id" });
    const homeDomain = (c.req.header("host") ?? "").split(":")[0]?.toLowerCase() ?? "";
    const now = clock.now();

    const result = await db.transaction(async (tx) => {
      // Two claims at once must not both create an organization.
      await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
      const [existing] = await tx.select({ id: org.id }).from(org).limit(1);
      if (existing) throw new ApiError("conflict", "This deployment is already set up.");

      const orgId = Bun.randomUUIDv7();
      await tx.insert(org).values({
        id: orgId,
        name: body.orgName,
        homeDomain,
        settings: DEFAULT_ORG_SETTINGS,
        pseudonymKey: randomBytes(32),
      });
      const [person] = await tx
        .insert(people)
        .values({ id: Bun.randomUUIDv7(), orgId, email: body.email, name: body.name, role: "owner" })
        .returning();
      if (!person) throw new Error("no person row");
      await tx.insert(passwords).values({ personId: person.id, orgId, hash });
      const token = await createCliToken(tx, {
        orgId,
        personId: person.id,
        name: `artifacts CLI on ${body.clientName}`,
        now,
      });
      return { person: personView(person), token };
    });
    return c.json(result);
  });

  routes.post("/api/recover", { public: true }, async (c) => {
    deps.limits.hit(`recover:${deps.clientIp(c)}`, 5, HOUR);
    const body = await parseBody(c, RecoverRequest);
    if (!safeEqual(body.setupToken, env.setupToken))
      throw new ApiError("forbidden", "That setup token is wrong.");
    const organization = c.get("org");
    const [owner] = await db
      .select()
      .from(people)
      .where(
        and(
          eq(people.orgId, organization.id),
          sql`lower(${people.email}) = lower(${body.email})`,
          eq(people.role, "owner"),
          isNull(people.removedAt),
        ),
      )
      .orderBy(asc(people.id))
      .limit(1);
    if (!owner) throw new ApiError("not_found", "No owner has that email address.");

    const secret = randomSecret();
    const now = clock.now();
    await db.insert(resetLinks).values({
      id: Bun.randomUUIDv7(),
      orgId: organization.id,
      personId: owner.id,
      tokenHash: sha256(secret),
      createdBy: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + HOUR),
    });
    await db.insert(activity).values({
      id: Bun.randomUUIDv7(),
      orgId: organization.id,
      kind: "recovered",
      actorPersonId: owner.id,
    });
    return c.json({ resetUrl: `${env.publicUrl}/reset/${secret}` });
  });
}
