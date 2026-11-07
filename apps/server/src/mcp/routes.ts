import { TEMPLATES } from "@artifacts/kit/templates";
import {
  ArticleTheme,
  articleHtmlPath,
  COMMENT_MAX,
  CreateThread,
  CreateWiki,
  EditRequest,
  FILES_MAX,
  KEY_PATTERN,
  MANIFEST,
  MINUTE_MS,
  normalizeRepo,
  OAUTH_SCOPES,
  PublishCommit,
  PublishPrepare,
  SHA256_HEX,
  SLUG_PATTERN,
  StartRun,
  SuggestionStatus,
  Summary,
  Tags,
  type Thread,
  UNTRUSTED_NOTICE,
  WikiMeta,
} from "@artifacts/schema";
import { articleRecords, buildArticle } from "@artifacts/schema/article";
import {
  EDIT_TOOLS,
  MCP_GUIDANCE as GUIDANCE,
  MCP_LEGACY as LEGACY,
  libraryTools,
  MCP_ARTIFACT,
  MCP_MAX_IMAGE,
  MCP_SERVER_INFO_META,
  MCP_SERVER_NAME,
  type McpProperty,
  type McpToolSpec,
  MCP_MODERN as MODERN,
  pageReadText,
  REPLY_INPUT,
  REVIEW_TOOLS,
  WIKI_ARTICLE_INPUT,
  WIKI_TOOLS,
} from "@artifacts/schema/mcp";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { GUIDES } from "../../../../skill/index.ts";
import { findArtifactBySlug, toProject } from "../auth/access.ts";
import type { Asker, Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { pages, projects, versions } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { applyOps, pageRead } from "../editing/ops.ts";
import { cancelRun, findRun, finishRun, startRun } from "../editing/runs.ts";
import { listSuggestions } from "../editing/suggestions.ts";
import { ApiError } from "../http/errors.ts";
import { MCP_PATH, requestOrigin } from "../http/origins.ts";
import type { ApiVars, Routes } from "../http/routes.ts";
import { blobKey, planKey } from "../layout.ts";
import {
  libraryArtifacts,
  libraryFrames,
  libraryPages,
  libraryProjects,
  librarySearch,
  loadArtifact,
} from "../library/browse.ts";
import { libraryCards } from "../library/cards.ts";
import { readArtifact, viewArtifact } from "../library/read.ts";
import { putBlob, verifyBlobs } from "../publish/blobs.ts";
import type { Publisher } from "../publish/publisher.ts";
import type { Review } from "../review/service.ts";
import { VERSION } from "../version.ts";
import { listVersions } from "../versions/list.ts";
import { artifactLinks, createWiki, notWiki, wikiSpace } from "../wiki/service.ts";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const MAX_REQUEST = 4 * 1024 * 1024;
/** A publish payload holds frames and block text, so it goes through the bucket, not tool arguments. */
const MAX_PAYLOAD = 32 * 1024 * 1024;
/** A long report is well under this. It's text a model writes, and the request itself has a limit. */
const MAX_MARKDOWN = 1024 * 1024;
const ARTICLE_PAGE = "doc";
const ARTICLES_PER_MINUTE = 30;

const INSTRUCTIONS = [
  GUIDANCE.library,
  GUIDANCE.wiki,
  `${GUIDANCE.searchFirst}, with your git remote as repo if you have one; this server can't see your repo.`,
  GUIDANCE.reading,
  GUIDANCE.untrusted,
  GUIDANCE.decisions,
  GUIDANCE.publish(""),
  `Use artifacts_publish_article for a text article, and artifacts pack then artifacts_publish_prepare for anything else. ${GUIDANCE.prototype}; artifacts://guides/micro-apps says what the sandbox blocks.`,
  GUIDANCE.sharing,
  "The artifacts://guides resources explain templates and structure. Publishing canvases or prototypes needs the artifacts CLI and WebKit on your machine, for artifacts pack.",
].join(" ");

class ToolError extends Error {}
class InsufficientScope extends Error {
  constructor(readonly scope: string) {
    super(`This needs the ${scope} scope.`);
  }
}

type Services = { publisher: Publisher; review: Review };
type Input = Record<string, unknown>;
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type McpCaller = Extract<Caller, { kind: "cliToken" | "orgToken" }>;
type Context = { asker: Asker<McpCaller>; caller: McpCaller; orgId: string; input: Input };
type Tool = McpToolSpec & {
  scope: "read" | "comment" | "edit" | "publish";
  run(context: Context): Promise<unknown | { content: Content[] }>;
};

const str = (value: unknown, name: string, max = 500) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) throw new ToolError(`${name} isn't valid.`);
  return value;
};
const whole = (value: unknown, name: string) => {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0)
    throw new ToolError(`${name} must be a whole number.`);
  return value as number;
};
const artifactOf = (value: unknown) => {
  const [project = "", slug = "", ...more] = String(value ?? "").split("/");
  if (more.length > 0 || !SLUG_PATTERN.test(project) || !SLUG_PATTERN.test(slug)) {
    throw new ToolError("artifact must look like project/artifact.");
  }
  return { project, slug };
};
const load = ({ orgId, caller, input }: Context, deps: Deps) => {
  const { project, slug } = artifactOf(input.artifact);
  return loadArtifact(deps, orgId, caller, project, slug);
};

/** Tool arguments as an `EditRequest`, with zod's words when they don't fit. */
const editRequest = (input: Input, suggest: boolean): EditRequest => {
  const parsed = EditRequest.safeParse({
    ops: input.ops,
    sources: input.sources,
    note: input.note,
    fixes: input.fixes,
    run: input.run,
    ...(suggest ? { suggest: true } : { checkpoint: input.checkpoint }),
    agent: "Connector",
  });
  if (!parsed.success) {
    throw new ToolError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("\n"),
    );
  }
  return parsed.data;
};

const threadJson = (thread: Thread) => {
  const [first, ...replies] = thread.comments;
  return {
    id: thread.n,
    page: thread.pageKey,
    anchor: thread.anchor,
    status: thread.status,
    version: thread.createdVersion,
    author: thread.author.name,
    authorKind: thread.author.kind,
    untrusted: true,
    text: first?.body ?? "",
    crop: thread.crop,
    replies: replies.map((reply) => ({
      author: reply.author.name,
      authorKind: reply.author.kind,
      untrusted: true,
      text: reply.body,
      marksFixed: reply.marksFixed,
    })),
  };
};

const fileEntry = z.object({
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  type: z.string(),
});
/** `artifacts pack` writes this. The server treats it exactly as it would the same JSON sent to the API. */
const Payload = PublishCommit.omit({ uploadId: true }).extend({
  declared: z.array(fileEntry).max(FILES_MAX),
});

function tools(deps: Deps, { publisher, review }: Services): Tool[] {
  const repo: McpProperty = {
    type: "string",
    description: "Your git remote, to look only at that repo's project",
  };
  const library = libraryTools(repo);

  /** Plans list signed uploads. They go in the bucket, so a long list doesn't fill a model's context. */
  async function plan(missing: unknown) {
    const key = planKey(Bun.randomUUIDv7());
    await deps.bucket.put(key, new TextEncoder().encode(JSON.stringify({ missing })), {
      contentType: "application/json",
    });
    return deps.bucket.presignGet(key);
  }

  async function readPayload(orgId: string, hash: string, size: number | null) {
    await verifyBlobs(deps, orgId, new Map([[hash, size]]));
    const object = await deps.bucket.get(blobKey(hash));
    if (!object) throw new ToolError("The payload isn't there. Upload it again.");
    try {
      return Payload.parse(JSON.parse(new TextDecoder().decode(object.body)));
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.issues.filter((issue) => issue.path[0] === "wiki");
        if (issues.length)
          throw new ToolError(issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
      }
      throw new ToolError("The payload isn't one artifacts pack made.");
    }
  }

  const publishArticle: Tool = {
    name: "artifacts_publish_article",
    description:
      "Publish Markdown as an article, with no CLI. No local images, Mermaid or embeds. Republishing makes a new version.",
    scope: "publish",
    properties: {
      project: { type: "string", description: "Project slug" },
      slug: { type: "string", description: "Artifact slug" },
      title: { type: "string", description: "Title" },
      summary: { type: "string", description: "What it holds and why it mattered, up to 280 characters" },
      markdown: { type: "string", description: "The article" },
      tags: { type: "array", description: "Up to 8" },
      message: { type: "string", description: "What changed" },
      repo,
      ...WIKI_ARTICLE_INPUT,
    },
    required: ["project", "slug", "title", "summary", "markdown"],
    async run({ asker, caller, orgId, input }) {
      const fields = PublishPrepare.pick({ project: true, slug: true, title: true }).safeParse(input);
      if (!fields.success) throw new ToolError("project, slug or title isn't valid.");
      const summary = Summary.safeParse(input.summary);
      if (!summary.success) throw new ToolError("summary is required, up to 280 characters.");
      const tags = Tags.optional().safeParse(input.tags);
      if (!tags.success) throw new ToolError("tags: up to 8, each up to 32 characters.");
      const markdown = typeof input.markdown === "string" ? input.markdown : "";
      if (!markdown.trim()) throw new ToolError("markdown is required.");
      if (Buffer.byteLength(markdown) > MAX_MARKDOWN) {
        throw new ApiError("too_large", "That article is too long.", { limit: MAX_MARKDOWN });
      }
      const wikiFields = Object.fromEntries(
        ["role", "sources", "origin", "untrusted"]
          .filter((k) => input[k] !== undefined)
          .map((k) => [k, input[k]]),
      );
      const wiki = Object.keys(wikiFields).length ? WikiMeta.safeParse(wikiFields) : null;
      if (wiki && !wiki.success)
        throw new ToolError(
          wiki.error.issues.map((issue) => `wiki.${issue.path.join(".")}: ${issue.message}`).join("\n"),
        );
      const wikiMeta = wiki?.success ? wiki.data : undefined;
      const { project, slug, title } = fields.data;
      // Before anything is stored: the permission check, and the same one prepare and commit run.
      const { row: existing } = await publisher.target(asker, project, slug);
      if (existing) {
        const rows = await deps.db
          .select({ key: pages.pageKey, kind: pages.kind })
          .from(pages)
          .innerJoin(versions, eq(versions.id, pages.versionId))
          .where(and(eq(versions.artifactId, existing.id), eq(versions.n, existing.latestVersion)));
        if (rows.length !== 1 || rows[0]?.kind !== "article" || rows[0]?.key !== ARTICLE_PAGE) {
          throw new ToolError("That artifact has other pages, which this would replace. Use artifacts pack.");
        }
      }
      const who = "tokenId" in caller ? caller.tokenId : "none";
      deps.limits.hit(`article:${who}`, ARTICLES_PER_MINUTE, MINUTE_MS);
      const built = buildArticle({
        project,
        path: "doc.md",
        source: markdown,
        readFile: () => "",
        blobHash: () => undefined,
        frameHash: () => undefined,
        mermaid: new Map(),
      });
      const problem = built.problems.find((entry) => entry.severity === "error");
      if (problem) {
        throw new ToolError(
          `${problem.message} This tool takes text only: images, Mermaid and embeds need artifacts pack.`,
        );
      }
      const encode = (text: string) => new TextEncoder().encode(text);
      const manifest = JSON.stringify(
        {
          project,
          slug,
          title,
          wiki: wikiMeta,
          summary: summary.data,
          ...(tags.data ? { tags: tags.data } : {}),
          pages: [{ id: ARTICLE_PAGE, kind: "article", src: "doc.md", title }],
        },
        null,
        2,
      );
      const types: [string, string, string][] = [
        ["doc.md", markdown, "text/markdown"],
        [MANIFEST, manifest, "application/json"],
        [articleHtmlPath(ARTICLE_PAGE), built.html, "text/html; charset=utf-8"],
      ];
      const stored = await Promise.all(
        types.map(async ([path, body, type]) => {
          const bytes = encode(body);
          return { path, sha256: await putBlob(deps, orgId, bytes, type), size: bytes.length, type };
        }),
      );
      const repoName = normalizeRepo(str(input.repo, "repo"));
      const prepared = await publisher.prepare(asker, {
        project,
        slug,
        title,
        repo: repoName,
        files: stored,
      });
      const theme = ArticleTheme.safeParse(asker.org.brand?.theme ?? {});
      const article = articleRecords(built, {
        id: ARTICLE_PAGE,
        title,
        group: null,
        position: 0,
        htmlHash: stored[2]?.sha256,
        theme: theme.success && Object.keys(theme.data).length > 0 ? theme.data : null,
      });
      return publisher.commit(asker, {
        uploadId: prepared.uploadId,
        message: str(input.message, "message", 2000) ?? null,
        name: null,
        summary: summary.data,
        tags: tags.data ?? null,
        wiki: wikiMeta,
        notes: {},
        agent: "Connector",
        files: Object.fromEntries(
          stored.map((file) => [file.path, { hash: file.sha256, size: file.size, type: file.type }]),
        ),
        backendHash: null,
        pages: [article.page],
        frames: [],
        blocks: article.blocks,
      });
    },
  };

  /** Editing wiki pages by operation (13, "Hosted MCP tools"). */
  const editTools: Tool[] = [
    {
      ...EDIT_TOOLS.read,
      scope: "read",
      async run(context) {
        const loaded = await load(context, deps);
        const draft = context.input.draft;
        if (draft !== undefined && typeof draft !== "boolean") throw new ToolError("draft is true or false.");
        const read = await pageRead(deps, context.caller, loaded, {
          draft,
          cursor: str(context.input.cursor, "cursor", 20),
        });
        return { content: [{ type: "text", text: pageReadText(read) }] };
      },
    },
    {
      ...EDIT_TOOLS.edit,
      scope: "edit",
      async run(context) {
        const loaded = await load(context, deps);
        return applyOps(deps, context.caller, loaded, editRequest(context.input, false));
      },
    },
    {
      ...EDIT_TOOLS.suggest,
      scope: "edit",
      async run(context) {
        const loaded = await load(context, deps);
        return applyOps(deps, context.caller, loaded, editRequest(context.input, true));
      },
    },
    {
      ...EDIT_TOOLS.create,
      scope: "publish",
      async run(context) {
        const wiki = str(context.input.wiki, "wiki", 40);
        const slug = str(context.input.slug, "slug", 40);
        if (!wiki || !slug || !SLUG_PATTERN.test(wiki) || !SLUG_PATTERN.test(slug))
          throw new ToolError("wiki and slug are lowercase slugs.");
        const [project] = await deps.db
          .select()
          .from(projects)
          .where(and(eq(projects.orgId, context.orgId), eq(projects.slug, wiki), eq(projects.kind, "wiki")));
        if (!project || !can(context.caller, "project.read", await toProject(deps, project)))
          throw new ApiError("not_found", "There's no such wiki.");
        const existing = await findArtifactBySlug(deps, context.orgId, wiki, slug);
        if (existing && can(context.caller, "artifact.read", existing)) {
          throw new ApiError("conflict", "That page exists. Change it with artifacts_page_edit.", {
            reason: "exists",
          });
        }
        const { wiki: _, ...rest } = context.input;
        return publishArticle.run({ ...context, input: { ...rest, project: wiki } });
      },
    },
    {
      ...EDIT_TOOLS.suggestions,
      scope: "edit",
      async run(context) {
        const loaded = await load(context, deps);
        if (!can(context.caller, "artifact.edit", loaded))
          throw new ApiError("forbidden", "Suggestions are for people and agents who can edit this page.");
        const raw = str(context.input.status, "status", 12) ?? "open";
        const status = raw === "all" ? undefined : SuggestionStatus.safeParse(raw);
        if (status && !status.success) throw new ToolError("status isn't one of the suggestion statuses.");
        return listSuggestions(deps, context.caller, loaded, {
          status: status?.data,
          run: str(context.input.run, "run", 40),
          cursor: str(context.input.cursor, "cursor", 40),
        });
      },
    },
    {
      ...EDIT_TOOLS.delegate,
      scope: "edit",
      async run(context) {
        const loaded = await load(context, deps);
        if (!can(context.caller, "artifact.edit", loaded))
          throw new ApiError("forbidden", "You can't edit this page.");
        const action = str(context.input.action, "action", 10);
        if (action === "start") {
          const body = StartRun.safeParse({ goal: context.input.goal, agent: "Connector" });
          if (!body.success) throw new ToolError("start needs a goal, up to 500 characters.");
          return startRun(deps, context.caller, loaded, body.data);
        }
        if (action !== "finish" && action !== "cancel")
          throw new ToolError("action is start, finish or cancel.");
        const id = str(context.input.run, "run", 40);
        const row = id ? await findRun(deps, context.orgId, id) : null;
        if (!row || row.artifactId !== loaded.id)
          throw new ApiError("not_found", "There's no such run on this page.");
        return action === "finish"
          ? finishRun(deps, context.caller, loaded, row, str(context.input.message, "message", 2000))
          : cancelRun(deps, context.caller, loaded, row);
      },
    },
  ];

  return [
    ...editTools,
    {
      ...WIKI_TOOLS.wiki,
      scope: "read",
      async run({ caller, orgId, input }) {
        const slug = str(input.wiki, "wiki", 40);
        const rows = await deps.db
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.orgId, orgId),
              eq(projects.kind, "wiki"),
              slug ? eq(projects.slug, slug) : undefined,
            ),
          );
        const spaces = [];
        for (const row of rows) {
          const place = await toProject(deps, row);
          if (!can(caller, "project.read", place)) continue;
          spaces.push(await wikiSpace(deps, orgId, caller, place));
        }
        if (!slug)
          return spaces.map((s) => ({
            slug: s.project.slug,
            name: s.project.name,
            audience: s.project.audience,
            guidance: s.project.guidance,
            pages: s.pages.length,
            sources: s.sources.length,
          }));
        const space = spaces[0];
        if (!space) {
          const [plain] = await deps.db
            .select()
            .from(projects)
            .where(and(eq(projects.orgId, orgId), eq(projects.slug, slug ?? "")));
          if (plain && can(caller, "project.read", await toProject(deps, plain)))
            throw new ApiError("not_found", notWiki(plain.slug));
          throw new ApiError("not_found", "Not found.");
        }
        const rulesText = space.rules
          ? await readArtifact(deps, await loadArtifact(deps, orgId, caller, slug, space.rules.slug), {})
          : null;
        return { ...space, log: space.log.slice(0, 20), rulesText };
      },
    },
    {
      ...WIKI_TOOLS.links,
      scope: "read",
      async run(context) {
        return artifactLinks(deps, context.orgId, context.caller, await load(context, deps));
      },
    },
    {
      ...WIKI_TOOLS.create,
      scope: "publish",
      async run({ caller, orgId, input }) {
        const parsed = CreateWiki.safeParse(input);
        if (!parsed.success)
          throw new ToolError(
            parsed.error.issues
              .map((issue) => `${issue.path.join(".") || "wiki"}: ${issue.message}`)
              .join("\n"),
          );
        return (await createWiki(deps, orgId, caller, parsed.data)).body;
      },
    },
    {
      ...WIKI_TOOLS.comment,
      scope: "comment",
      async run(context) {
        const loaded = await load(context, deps);
        if (!can(context.caller, "artifact.comment", loaded)) throw new ToolError("You can't comment here.");
        const [page] = await deps.db
          .select({ key: pages.pageKey })
          .from(pages)
          .innerJoin(versions, eq(versions.id, pages.versionId))
          .where(and(eq(versions.artifactId, loaded.id), eq(versions.n, loaded.row.latestVersion)))
          .orderBy(pages.position);
        const body = CreateThread.safeParse({
          pageKey: str(context.input.page, "page", 60) ?? page?.key,
          body: context.input.message,
          version: loaded.row.latestVersion,
          anchor: null,
          agent: "Connector",
        });
        if (!body.success) throw new ToolError("The comment isn't valid.");
        const thread = await review.startThread(context.asker, loaded, body.data);
        return { id: thread.n };
      },
    },
    {
      ...library.search,
      scope: "read",
      run: ({ caller, orgId, input }) =>
        librarySearch(deps, orgId, caller, {
          q: str(input.query, "query") ?? "",
          project: str(input.project, "project", 40),
          repo: str(input.repo, "repo"),
          limit: whole(input.limit, "limit")?.toString(),
          cursor: str(input.cursor, "cursor", 40),
        }),
    },
    {
      ...library.list,
      scope: "read",
      async run(context) {
        const { caller, orgId, input } = context;
        const window = {
          limit: whole(input.limit, "limit")?.toString(),
          cursor: str(input.cursor, "cursor", 40),
        };
        const path = str(input.path, "path", 200);
        const parts = path ? path.split("/") : [];
        if (parts.length > 3 || !parts.every((part) => KEY_PATTERN.test(part))) {
          throw new ToolError("path must look like project, project/artifact or project/artifact/page.");
        }
        const [project, slug, page] = parts;
        if (!project)
          return libraryProjects(deps, orgId, caller, { repo: str(input.repo, "repo"), ...window });
        if (!slug) return libraryArtifacts(deps, orgId, caller, { project, ...window });
        const loaded = await loadArtifact(deps, orgId, caller, project, slug);
        return page
          ? libraryFrames(deps, loaded, { page, ...window })
          : libraryPages(deps, caller, loaded, window);
      },
    },
    {
      ...library.read,
      scope: "read",
      run: async (context) =>
        readArtifact(deps, await load(context, deps), {
          page: str(context.input.page, "page", 60),
          version: whole(context.input.version, "version"),
          cursor: str(context.input.cursor, "cursor", 40),
        }),
    },
    {
      ...library.view,
      scope: "read",
      async run(context) {
        const loaded = await load(context, deps);
        const view = await viewArtifact(deps, loaded, {
          page: str(context.input.page, "page", 60),
          frame: str(context.input.frame, "frame", 100),
          size: str(context.input.size, "size", 8),
        });
        const hash = /\/r\/([0-9a-f]{64})/.exec(view.image ?? "")?.[1];
        const object = hash ? await deps.bucket.get(blobKey(hash)) : null;
        if (!object) throw new ToolError("This artifact has no picture to show.");
        if (object.body.length > MCP_MAX_IMAGE)
          throw new ToolError("That picture is too big. Ask for a smaller size.");
        const { image: _, ...about } = view;
        return {
          content: [
            { type: "text", text: JSON.stringify(about) },
            { type: "image", data: Buffer.from(object.body).toString("base64"), mimeType: "image/webp" },
          ],
        };
      },
    },
    {
      ...REVIEW_TOOLS.status,
      scope: "read",
      properties: { artifact: MCP_ARTIFACT },
      required: ["artifact"],
      async run(context) {
        const loaded = await load(context, deps);
        const [card] = await libraryCards(deps, context.caller, [loaded]);
        const status = await review.status(context.asker, loaded);
        return {
          version: status.version,
          outcome: card?.outcome,
          open: status.open.map(threadJson),
          ...(status.audience === undefined ? {} : { audience: status.audience }),
        };
      },
    },
    {
      ...REVIEW_TOOLS.comments,
      scope: "read",
      properties: {
        artifact: MCP_ARTIFACT,
        status: { type: "string", description: "open, fixed, resolved or all" },
      },
      required: ["artifact"],
      async run(context) {
        const loaded = await load(context, deps);
        const status = str(context.input.status, "status", 10) ?? "open";
        return (await review.listThreads(loaded.row.id, { status })).views.map(threadJson);
      },
    },
    {
      ...REVIEW_TOOLS.reply,
      scope: "comment",
      properties: {
        artifact: MCP_ARTIFACT,
        n: { type: "number", description: "The comment's number" },
        ...REPLY_INPUT,
      },
      required: ["artifact", "n", "message"],
      async run(context) {
        const { asker, caller, input } = context;
        const loaded = await load(context, deps);
        if (!can(caller, "artifact.comment", loaded)) throw new ToolError("You can't comment here.");
        const { rows } = await review.listThreads(loaded.row.id);
        const thread = rows.find((row) => row.n === input.n);
        if (!thread) throw new ToolError("There's no such comment.");
        const body = str(input.message, "message", COMMENT_MAX);
        if (!body?.trim()) throw new ToolError("message is required.");
        const comment = await review.replyTo(asker, loaded, thread, {
          body,
          marksFixed: input.fixed === true,
          agent: "Connector",
        });
        return { id: comment.id, version: comment.version, marksFixed: comment.marksFixed };
      },
    },
    {
      ...REVIEW_TOOLS.versions,
      description: "An artifact's versions, newest first.",
      scope: "read",
      properties: { artifact: MCP_ARTIFACT },
      required: ["artifact"],
      async run(context) {
        const loaded = await load(context, deps);
        const rows = await listVersions(deps, loaded.id, 100);
        return rows.map(({ version, by }) => ({
          n: version.n,
          name: version.name,
          message: version.message,
          summary: version.summary,
          publishedBy: by,
          agent: version.agent,
          publishedAt: version.publishedAt.toISOString(),
        }));
      },
    },
    publishArticle,
    {
      name: "artifacts_publish_prepare",
      description:
        "Start a publish from artifacts pack. Call it again after each upload the answer asks for.",
      scope: "publish",
      properties: {
        project: { type: "string", description: "Project slug" },
        projectName: { type: "string", description: "Project name" },
        repo,
        slug: { type: "string", description: "Artifact slug" },
        title: { type: "string", description: "Title" },
        visibility: { type: "string", description: "me or org" },
        payload: { type: "object", description: "{ sha256, size } from artifacts pack" },
      },
      required: ["project", "slug", "title", "payload"],
      async run({ asker, input, orgId }) {
        const payload = z
          .object({ sha256: z.string().regex(SHA256_HEX), size: z.number().int().positive() })
          .safeParse(input.payload);
        if (!payload.success)
          throw new ToolError("payload wants the sha256 and size artifacts pack printed.");
        if (payload.data.size > MAX_PAYLOAD) throw new ApiError("too_large", "That payload is too big.");
        const { payload: _, ...fields } = input;
        const meta = PublishPrepare.omit({ files: true }).safeParse({
          ...fields,
          repo: normalizeRepo(fields.repo as string),
        });
        if (!meta.success) throw new ToolError("project, slug or title isn't valid.");
        // Before anything is signed: a caller who can't publish here gets no upload URL at all.
        await publisher.target(asker, meta.data.project, meta.data.slug);
        const { sha256, size } = payload.data;
        if (!(await deps.bucket.head(blobKey(sha256)))) {
          const signed = await deps.bucket.presignPut(blobKey(sha256), {
            contentType: "application/json",
            contentLength: size,
            cacheControl: "private, max-age=0",
          });
          return {
            step: "upload_payload",
            plan: await plan([{ sha256, ...signed }]),
            next: "Run artifacts pack --upload <plan>, then call this again with the same arguments.",
          };
        }
        const body = await readPayload(orgId, sha256, size);
        const prepared = await publisher.prepare(asker, { ...meta.data, files: body.declared }, sha256);
        return {
          step: "upload_files",
          uploadId: prepared.uploadId,
          missing: prepared.missing.length,
          plan: await plan(prepared.missing),
          next: "Run artifacts pack --upload <plan>, then call artifacts_publish_commit.",
        };
      },
    },
    {
      name: "artifacts_publish_commit",
      description: "Finish a publish, once every file is uploaded. Checks each one as strictly as the API.",
      scope: "publish",
      properties: {
        uploadId: { type: "string", description: "From artifacts_publish_prepare" },
        payload: { type: "string", description: "The payload's sha256" },
      },
      required: ["uploadId", "payload"],
      async run({ asker, input, orgId }) {
        const hash = str(input.payload, "payload", 64) ?? "";
        if (!SHA256_HEX.test(hash)) throw new ToolError("payload wants the payload's sha256.");
        const { declared: _, ...body } = await readPayload(orgId, hash, null);
        const commit = PublishCommit.parse({ ...body, uploadId: str(input.uploadId, "uploadId", 8000) });
        return publisher.commit(asker, commit, hash);
      },
    },
  ];
}

const uriOf = {
  guide: (name: string) => `artifacts://guides/${name}`,
  template: (name: string, path: string) => `artifacts://templates/${name}/${path}`,
};

const resources = () => [
  ...Object.keys(GUIDES).map((name) => ({
    uri: uriOf.guide(name),
    name: `Guide: ${name}`,
    mimeType: "text/markdown",
  })),
  ...Object.entries(TEMPLATES).flatMap(([name, files]) =>
    Object.keys(files).map((path) => ({
      uri: uriOf.template(name, path),
      name: `Template ${name}: ${path}`,
      mimeType: path.endsWith(".md") ? "text/markdown" : "text/plain",
    })),
  ),
];

function readResource(uri: string) {
  const guide = /^artifacts:\/\/guides\/(.+)$/.exec(uri)?.[1];
  const text = guide
    ? Object.hasOwn(GUIDES, guide)
      ? GUIDES[guide]
      : undefined
    : (() => {
        const match = /^artifacts:\/\/templates\/([a-z-]+)\/(.+)$/.exec(uri);
        if (!match || !Object.hasOwn(TEMPLATES, match[1] as string)) return undefined;
        const files = TEMPLATES[match[1] as string] as Record<string, string>;
        return Object.hasOwn(files, match[2] as string) ? files[match[2] as string] : undefined;
      })();
  return text === undefined
    ? null
    : { uri, mimeType: uri.endsWith(".md") ? "text/markdown" : "text/plain", text };
}

/** 401s and 403s say where to sign in, however they came about (MCP, authorization). */
export function mcpChallenge(deps: Deps): MiddlewareHandler<ApiVars> {
  return async (c, next) => {
    await next();
    const origin = await requestOrigin(c, deps);
    if (c.res.status === 401 && origin) {
      c.res.headers.set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${MCP_PATH}", scope="${OAUTH_SCOPES.join(" ")}"`,
      );
    }
  };
}

const rpcError = (id: unknown, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});
const cacheable = { ttlMs: 3_600_000, cacheScope: "private" };

export function mcpRoutes(routes: Routes, deps: Deps, services: Services) {
  const list = tools(deps, services);
  const capabilities = { tools: {}, resources: {} };
  const serverInfo = { name: MCP_SERVER_NAME, version: VERSION };

  routes.post(MCP_PATH, { action: "home.read", inHandler: true }, async (c) => {
    const caller = c.var.caller;
    // Only a token: a browser's cookie has no business here, whatever it could do on the API.
    if (!(caller.kind === "cliToken" || caller.kind === "orgToken")) {
      throw new ApiError("unauthenticated", "Sign in first.");
    }
    // A bearer skips the CSRF guard, but the transport has its own rule: DNS rebinding comes from a
    // browser, which always says where it is. Native clients send no Origin.
    const origin = c.req.header("origin");
    if (origin && !(await deps.origins()).includes(origin)) {
      throw new ApiError("forbidden", "This request came from another site.");
    }
    const raw = await c.req.text();
    if (raw.length > MAX_REQUEST) throw new ApiError("too_large", "That's too long.", { limit: MAX_REQUEST });
    let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(raw);
    } catch {
      return c.json(rpcError(null, -32700, "That isn't JSON."), 400);
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return c.json(rpcError(null, -32600, "Send one message at a time."), 400);
    }
    if (message.method === undefined || message.id === undefined) return c.body(null, 202);

    const { id, method, params = {} } = message;
    const bodyVersion = (params._meta as Record<string, unknown> | undefined)?.[META_VERSION];
    const headerVersion = c.req.header("mcp-protocol-version");
    const modern = bodyVersion !== undefined;
    const supported = [MODERN, ...LEGACY];
    if (modern) {
      const name = typeof params.name === "string" ? params.name : params.uri;
      const mcpName = c.req.header("mcp-name");
      const needsName = method === "tools/call" || method === "resources/read";
      const decoded = mcpName?.startsWith("=?base64?")
        ? Buffer.from(mcpName.slice(9, -2), "base64").toString()
        : mcpName;
      if (
        headerVersion !== bodyVersion ||
        c.req.header("mcp-method") !== method ||
        (needsName && decoded !== name)
      ) {
        return c.json(rpcError(id, -32020, "The headers don't match the request."), 400);
      }
    }
    const requested = (modern ? bodyVersion : headerVersion) as string | undefined;
    if (requested !== undefined && !supported.includes(requested) && method !== "initialize") {
      return c.json(rpcError(id, -32022, "Unsupported protocol version.", { supported, requested }), 400);
    }
    const ok = (result: object) =>
      c.json({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } });

    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion as string;
        return ok({
          protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0],
          capabilities,
          serverInfo,
          instructions: INSTRUCTIONS,
        });
      }
      case "server/discover":
        return ok({
          supportedVersions: supported,
          capabilities,
          _meta: { [MCP_SERVER_INFO_META]: serverInfo },
          instructions: INSTRUCTIONS,
          ...cacheable,
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: list.map(({ name, description, properties, required }) => ({
            name,
            description,
            inputSchema: { type: "object", properties, required: required ?? [] },
          })),
          ...cacheable,
        });
      case "resources/list":
        return ok({ resources: resources(), ...cacheable });
      case "resources/templates/list":
        return ok({ resourceTemplates: [], ...cacheable });
      case "resources/read": {
        const content = readResource(String(params.uri));
        if (!content) return c.json(rpcError(id, -32602, "No such resource."));
        return ok({ contents: [content], ...cacheable });
      }
      case "tools/call": {
        const tool = list.find((entry) => entry.name === params.name);
        if (!tool) return c.json(rpcError(id, -32602, "No such tool."));
        const input = (params.arguments ?? {}) as Input;
        try {
          if (!caller.scopes.includes(tool.scope)) throw new InsufficientScope(tool.scope);
          const result = await tool.run({
            asker: { org: c.var.org, caller },
            caller,
            orgId: c.var.org.id,
            input,
          });
          const content =
            typeof result === "object" && result !== null && "content" in result
              ? (result as { content: Content[] }).content
              : [{ type: "text", text: JSON.stringify(result) }];
          return ok({
            content: tool.untrusted ? [{ type: "text", text: UNTRUSTED_NOTICE }, ...content] : content,
          });
        } catch (error) {
          if (error instanceof InsufficientScope) {
            const origin = await requestOrigin(c, deps);
            c.header(
              "WWW-Authenticate",
              `Bearer error="insufficient_scope", scope="${error.scope}", resource_metadata="${origin}/.well-known/oauth-protected-resource${MCP_PATH}"`,
            );
            return c.json(rpcError(id, -32001, error.message), 403);
          }
          if (error instanceof ToolError || error instanceof ApiError) {
            return ok({ isError: true, content: [{ type: "text", text: error.message }] });
          }
          throw error;
        }
      }
      default:
        return c.json(rpcError(id, -32601, "No such method."), modern ? 404 : 200);
    }
  });
}
