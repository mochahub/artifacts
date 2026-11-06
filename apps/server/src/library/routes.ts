import { isBundlePath, type VersionBundle } from "@artifacts/schema";
import { desc, eq } from "drizzle-orm";
import { decisions, pages, people } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { artifactParam } from "../http/resources.ts";
import type { ApiContext, Routes } from "../http/routes.ts";
import { mapLimit } from "../map-limit.ts";
import { blobKey } from "../publish/blobs.ts";
import {
  libraryArtifacts,
  libraryFrames,
  libraryPages,
  libraryProjects,
  librarySearch,
  loadArtifact,
} from "./browse.ts";
import { libraryCards } from "./cards.ts";
import { rebuildManifest } from "./manifest.ts";
import { liveVersion, readArtifact, viewArtifact } from "./read.ts";

export function libraryRoutes(routes: Routes, deps: Deps) {
  const { db, bucket } = deps;
  const artifact = artifactParam(deps);
  const byName = (c: ApiContext) =>
    loadArtifact(
      deps,
      c.get("org").id,
      c.get("caller"),
      c.req.param("project") as string,
      c.req.param("slug") as string,
    );

  routes.get("/api/library/search", { action: "home.read" }, async (c) =>
    c.json(
      await librarySearch(deps, c.get("org").id, c.get("caller"), {
        q: c.req.query("q") ?? "",
        project: c.req.query("project"),
        repo: c.req.query("repo"),
        archived: c.req.query("archived") !== "false",
        limit: c.req.query("limit"),
        cursor: c.req.query("cursor"),
      }),
    ),
  );

  routes.get("/api/library/projects", { action: "project.list" }, async (c) =>
    c.json(
      await libraryProjects(deps, c.get("org").id, c.get("caller"), {
        repo: c.req.query("repo"),
        limit: c.req.query("limit"),
        cursor: c.req.query("cursor"),
      }),
    ),
  );

  routes.get("/api/library/projects/:project", { action: "project.read" }, async (c) =>
    c.json(
      await libraryArtifacts(deps, c.get("org").id, c.get("caller"), {
        project: c.req.param("project") as string,
        limit: c.req.query("limit"),
        cursor: c.req.query("cursor"),
      }),
    ),
  );

  routes.get(
    "/api/library/projects/:project/:slug",
    { action: "artifact.read", inHandler: true },
    async (c) => {
      const caller = c.get("caller");
      if (caller.kind === "anonymous") throw new ApiError("unauthenticated", "Sign in first.");
      const loaded = await byName(c as ApiContext);
      return c.json(
        await libraryPages(deps, caller, loaded, {
          limit: c.req.query("limit"),
          cursor: c.req.query("cursor"),
        }),
      );
    },
  );

  routes.get(
    "/api/library/projects/:project/:slug/pages/:page",
    { action: "artifact.read", inHandler: true },
    async (c) => {
      if (c.get("caller").kind === "anonymous") throw new ApiError("unauthenticated", "Sign in first.");
      return c.json(
        await libraryFrames(deps, await byName(c as ApiContext), {
          page: c.req.param("page") as string,
          limit: c.req.query("limit"),
          cursor: c.req.query("cursor"),
        }),
      );
    },
  );

  routes.get(
    "/api/library/projects/:project/:slug/read",
    { action: "artifact.read", inHandler: true },
    async (c) => {
      if (c.get("caller").kind === "anonymous") throw new ApiError("unauthenticated", "Sign in first.");
      const version = c.req.query("version");
      const chars = c.req.query("chars");
      return c.json(
        await readArtifact(deps, await byName(c as ApiContext), {
          page: c.req.query("page"),
          version: version ? Number(version) : undefined,
          cursor: c.req.query("cursor"),
          chars: chars ? Number(chars) || undefined : undefined,
        }),
      );
    },
  );

  routes.get(
    "/api/library/projects/:project/:slug/view",
    { action: "artifact.read", inHandler: true },
    async (c) => {
      if (c.get("caller").kind === "anonymous") throw new ApiError("unauthenticated", "Sign in first.");
      const version = c.req.query("version");
      return c.json(
        await viewArtifact(deps, await byName(c as ApiContext), {
          page: c.req.query("page"),
          frame: c.req.query("frame"),
          size: c.req.query("size"),
          version: version ? Number(version) : undefined,
        }),
      );
    },
  );

  /** Everything `artifacts pull` and `export` need. The content host can't serve them: it only answers iframes. */
  routes.get(
    "/api/library/projects/:project/:slug/bundle",
    { action: "artifact.read", inHandler: true },
    async (c) => {
      if (c.get("caller").kind === "anonymous") throw new ApiError("unauthenticated", "Sign in first.");
      const loaded = await byName(c as ApiContext);
      const number = c.req.query("version");
      const version = await liveVersion(deps, loaded, number ? Number(number) : undefined);
      const files = version.files as Record<string, { hash: string; size: number; type: string }>;
      const stored = files["artifact.json"];
      const object = stored ? await bucket.get(blobKey(stored.hash)) : null;
      let manifest: Record<string, unknown> | null = null;
      try {
        manifest = object ? JSON.parse(new TextDecoder().decode(object.body)) : null;
      } catch {}
      const rebuilt = manifest === null;
      if (!manifest) {
        const pageRows = await db
          .select()
          .from(pages)
          .where(eq(pages.versionId, version.id))
          .orderBy(pages.position);
        const [card] = await libraryCards(deps, c.get("caller"), [loaded]);
        manifest = rebuildManifest(
          {
            project: loaded.projectSlug,
            slug: loaded.row.slug,
            title: loaded.row.title,
            visibility: loaded.row.visibility,
            summary: version.summary ?? card?.summary ?? loaded.row.title,
          },
          files,
          pageRows,
        );
      }
      // Older versions were never checked, so a bad path is left out here as well as refused by the CLI.
      const listed = Object.entries(files).filter(([path]) => isBundlePath(path));
      const body: VersionBundle = {
        project: loaded.projectSlug,
        slug: loaded.row.slug,
        version: version.n,
        manifest,
        rebuilt,
        files: await mapLimit(listed, 32, async ([path, file]) => ({
          path,
          hash: file.hash,
          size: file.size,
          type: file.type,
          url: await bucket.presignGet(blobKey(file.hash)),
        })),
      };
      return c.json(body);
    },
  );

  routes.get("/api/artifacts/:id/decisions", { action: "artifact.read", resource: artifact }, async (c) => {
    const rows = await db
      .select({ row: decisions, by: people.name })
      .from(decisions)
      .innerJoin(people, eq(people.id, decisions.personId))
      .where(eq(decisions.artifactId, c.req.param("id") as string))
      .orderBy(desc(decisions.createdAt));
    return c.json(
      rows.map(({ row, by }) => ({
        version: row.version,
        kind: row.kind,
        note: row.note,
        by,
        at: row.createdAt.toISOString(),
      })),
    );
  });
}
