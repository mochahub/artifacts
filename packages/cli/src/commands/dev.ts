import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  type Artifact,
  type ArtifactCard,
  type ContentToken,
  type DataList,
  type DataValue,
  DEFAULT_ORG_SETTINGS,
  type Home,
  isDataKey,
  type Me,
  type Meta,
  type Person,
  type ProjectArtifacts,
  type ProjectRow,
  type VersionRow,
} from "@artifacts/schema";
import type { z } from "zod";
import type { Caller, LocalStore } from "../../../sandbox/src/index.js";
import { BACKEND_BUNDLE, DATA_DIR, LOCAL } from "../bundle/layout.ts";
import { findRoot, loadManifest } from "../bundle/manifest.ts";
import { type Input, portOption } from "../command.ts";
import { viewerAssets } from "../dev/assets.ts";
import { staticLint } from "../lint/static.ts";
import { CliError, type Output } from "../output.ts";
import { sandboxHost } from "../render/install.ts";
import { type RenderResult, render } from "../render/render.ts";

const ID = "00000000-0000-7000-8000-00000000d0d0";
const PERSON: z.input<typeof Person> = {
  id: "00000000-0000-7000-8000-00000000d0d1",
  name: "You",
  email: "you@localhost",
  role: "owner",
};

/** The one person a local backend serves. */
const LOCAL_CALLER: Caller = { id: "local", name: "You", kind: "owner", canComment: true, isPublisher: true };

const etagOf = (path: string) => String(Math.floor(statSync(path).mtimeMs * 1000));

/** .artifacts/data, laid out like the bucket's data prefix (08). A key can't name a place outside it. */
function fileStore(dir: string): LocalStore {
  const at = (key: string) => {
    const full = resolve(dir, key);
    if (!full.startsWith(resolve(dir) + sep)) throw new CliError("Keys stay in the data folder.");
    return full;
  };
  return {
    valid: isDataKey,
    keys: () => (existsSync(dir) ? [...new Bun.Glob("**/*").scanSync(dir)] : []),
    get(key) {
      const path = at(key);
      return existsSync(path)
        ? { value: JSON.parse(readFileSync(path, "utf8")), etag: etagOf(path) }
        : undefined;
    },
    etag: (key) => (existsSync(at(key)) ? etagOf(at(key)) : null),
    put(key, value) {
      const path = at(key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(value));
      return etagOf(path);
    },
    delete: (key) => rmSync(at(key), { force: true }),
  };
}

/** The local API answers in the server's shapes (03), so a change to one fails to compile here. */
type Shape<T extends z.ZodType> = z.input<T>;
const json = (body: unknown, status = 200) => Response.json(body, { status });
const answer = <T extends z.ZodType>(body: Shape<T>) => json(body);
const fail = (status: number, code: string, message: string) =>
  json({ error: { code, message, details: {} } }, status);

/**
 * `artifacts dev` (07): the real viewer, on this machine, over a small local API. Nothing leaves the
 * machine, comments are off, and saved data lives in .artifacts/data/. Each change renders again as
 * the next version, so an open viewer picks it up on its next poll.
 */
export async function devCommand({ flags: given }: Input<never, { port?: string }>, out: Output) {
  const flags = { port: portOption(given.port) ?? 4321 };
  const root = findRoot();
  const assets = await viewerAssets();
  if (assets.size === 0) throw new CliError("The viewer isn't built. Run: bun run build");
  const viewerOrigin = `http://localhost:${flags.port}`;
  const contentOrigin = `http://127.0.0.1:${flags.port + 1}`;
  // The content host answers any website with CORS *, as the real one does, and the real one keeps
  // out strangers with a signed token in the path. This is that token: a page you happen to have
  // open can't guess it, so it can't read the draft or drive its backend through your browser.
  const secret = randomBytes(16).toString("hex");
  /** Only these Host headers, so a name that a stranger's DNS points at this machine gets nothing (DNS rebinding). */
  const hostsOf = (port: number) => new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const viewerHosts = hostsOf(flags.port);
  const contentHosts = hostsOf(flags.port + 1);
  const wrongHost = (request: Request, allowed: Set<string>) =>
    allowed.has(request.headers.get("host") ?? "") ? null : new Response("Wrong host", { status: 403 });
  const dataDir = join(root, DATA_DIR);
  let version = 0;
  let built: RenderResult | null = null;
  let title = "";
  let project = "";
  let slug = "";

  async function rebuild() {
    const { manifest, problems } = loadManifest(root);
    if (!manifest) {
      for (const problem of problems) out.warn(problem.message);
      return;
    }
    const checked = await staticLint(root, manifest);
    for (const problem of checked.problems) out.warn(`${problem.rule}  ${problem.message}`);
    built = render(root, manifest, checked.files, { lint: false }, out);
    version += 1;
    ({ title, project, slug } = manifest);
    out.say(`✓ v${version}  ${viewerOrigin}/${project}/${slug}`);
  }

  const blob = (hash: string) => {
    if (!built) return null;
    const file = [...built.files.values()].find((entry) => entry.hash === hash);
    if (file) return { path: file.source, type: file.type };
    const render_ = built.renders.get(hash);
    return render_ ? { path: render_, type: "image/webp" } : null;
  };

  const pages = () =>
    built?.pages.map((page) => ({
      key: page.key,
      kind: page.kind,
      title: page.title,
      group: page.group,
      changed: false,
      open: 0,
    })) ?? [];

  const card = (): Shape<typeof ArtifactCard> => ({
    id: ID,
    project,
    slug,
    title,
    cover: { title },
    pageCount: built?.pages.length ?? 0,
    latestVersion: version,
    status: { kind: "not_reviewed" },
    counts: { open: 0, repliesToYou: 0, changedFrames: 0 },
    publishedBy: "You",
    agent: null,
    publishedAt: new Date().toISOString(),
    archivedAt: null,
  });

  const artifact = (): Shape<typeof Artifact> => ({
    ...card(),
    visibility: "me",
    publisherId: PERSON.id,
    hasBackend: false,
    pages: pages(),
    decision: null,
    // Comments need a server, so the local viewer is read-only for review.
    permissions: { comment: false, manage: false, share: false, delete: false, purge: false },
  });

  const versionBody = () => ({
    n: version,
    notes: {},
    pages: built?.pages.map((page) => {
      const base = { key: page.key, kind: page.kind, title: page.title, group: page.group };
      if (page.kind === "article") {
        return {
          ...base,
          htmlHash: page.meta.htmlHash,
          outline: page.meta.outline,
          readingMinutes: page.meta.readingMinutes,
          blocks: built?.blocks
            .filter((block) => block.pageKey === page.key)
            .map((block) => ({ key: block.blockKey, contentHash: block.contentHash, changed: false })),
        };
      }
      return {
        ...base,
        boards: page.meta.boards ?? [],
        meta: page.meta,
        frames: built?.frames
          .filter((frame) => frame.pageKey === page.key)
          .map((frame) => ({
            key: frame.frameKey,
            board: frame.boardKey,
            title: frame.title,
            device: frame.device,
            x: frame.x,
            y: frame.y,
            w: frame.w,
            h: frame.h,
            contentHash: frame.contentHash,
            renders: frame.renders,
            live: frame.livePath !== null,
            livePath: frame.livePath,
            changed: false,
          })),
      };
    }),
  });

  /** .artifacts/data, laid out like the bucket, with `me` as one local person (08). */
  function dataRoute(request: Request, kind: string, scope: string, key: string) {
    if (scope !== "shared" && scope !== "me") return fail(404, "not_found", "Not found.");
    const base = join(dataDir, kind === "files" ? "files" : "", scope);
    const path = join(base, key);
    if (key && !path.startsWith(`${base}/`)) return fail(400, "invalid", "Bad key.");
    if (!key) {
      const found: string[] = [];
      const walk = (dir: string) => {
        if (!existsSync(dir)) return;
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else found.push(relative(base, full));
        }
      };
      walk(base);
      const prefix = new URL(request.url).searchParams.get("prefix") ?? "";
      const entries = found
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({
          key: name,
          etag: etagOf(join(base, name)),
          size: 0,
          updatedAt: new Date().toISOString(),
        }));
      return kind === "files"
        ? json({ files: entries.map(({ key: name, ...rest }) => ({ name, ...rest })), nextCursor: null })
        : answer<typeof DataList>({ keys: entries, nextCursor: null });
    }
    if (request.method === "GET") {
      if (!existsSync(path)) return fail(404, "not_found", "Not found.");
      if (kind === "files") return json({ url: `${viewerOrigin}/__data/${scope}/${key}` });
      return answer<typeof DataValue>({
        value: JSON.parse(readFileSync(path, "utf8")),
        etag: etagIfAny(path),
      });
    }
    if (request.method === "DELETE") {
      rmSync(path, { force: true });
      return json({ ok: true });
    }
    return null;
  }

  const etagIfAny = (path: string) => (existsSync(path) ? etagOf(path) : "");

  async function putData(request: Request, kind: string, scope: string, key: string) {
    if (!isDataKey(key)) return fail(400, "invalid", "That isn't a valid key.");
    const path = join(dataDir, kind === "files" ? "files" : "", scope, key);
    const ifMatch = request.headers.get("if-match");
    if (ifMatch && etagIfAny(path) !== ifMatch)
      return fail(412, "precondition_failed", "Someone wrote first.");
    if (request.headers.get("if-none-match") === "*" && existsSync(path)) {
      return fail(412, "precondition_failed", "Someone wrote first.");
    }
    mkdirSync(dirname(path), { recursive: true });
    if (kind === "files") writeFileSync(path, new Uint8Array(await request.arrayBuffer()));
    else writeFileSync(path, JSON.stringify(((await request.json()) as { value: unknown }).value));
    return json({ etag: etagIfAny(path), name: key });
  }

  async function handle(request: Request) {
    const refused = wrongHost(request, viewerHosts);
    if (refused) return refused;
    const url = new URL(request.url);
    const path = url.pathname;
    const inArtifact = `/api/artifacts/${ID}`;
    if (path === "/api/meta") {
      return answer<typeof Meta>({
        version: "dev",
        minCliVersion: "0.0.0",
        orgName: "Local",
        homeDomain: "localhost",
        publicUrl: viewerOrigin,
        contentUrl: contentOrigin,
        viewerOrigins: [viewerOrigin],
      });
    }
    if (path === "/api/me")
      return answer<typeof Me>({ person: PERSON, org: { name: "Local" }, recentAuth: false });
    if (path === "/api/home") return answer<typeof Home>({ waiting: [card()], recent: [] });
    if (path === "/api/projects") {
      return answer<z.ZodArray<typeof ProjectRow>>([
        {
          id: ID,
          slug: project,
          name: project,
          repo: null,
          artifactCount: 1,
          openCount: 0,
          updatedAt: new Date().toISOString(),
        },
      ]);
    }
    if (path === `/api/projects/${project}/artifacts`) {
      return answer<typeof ProjectArtifacts>({
        project: { slug: project, name: project, repo: null },
        artifacts: [card()],
      });
    }
    if (path === `/api/artifacts/by-slug/${project}/${slug}` || path === inArtifact) return json(artifact());
    if (path === `${inArtifact}/threads`) return json([]);
    if (path === `${inArtifact}/seen`) return json({ ok: true });
    if (path === `${inArtifact}/versions`) {
      return answer<z.ZodArray<typeof VersionRow>>([
        {
          n: version,
          name: null,
          message: "Local",
          publishedBy: "You",
          agent: null,
          publishedAt: new Date().toISOString(),
          restoredFrom: null,
          changes: { frames: 0, blocks: 0 },
        },
      ]);
    }
    if (path === `${inArtifact}/versions/${version}`) return json(versionBody());
    if (path === `${inArtifact}/content-token`) {
      return answer<typeof ContentToken>({
        base: `${contentOrigin}/${secret}/v${version}/`,
        expiresAt: new Date(Date.now() + 7200_000).toISOString(),
      });
    }
    const render_ = new RegExp(`^${inArtifact}/r/([0-9a-f]{64})$`).exec(path);
    if (render_) {
      const found = blob(render_[1] as string);
      return found
        ? new Response(Bun.file(found.path), { headers: { "Content-Type": found.type } })
        : fail(404, "not_found", "Not found.");
    }
    const article = new RegExp(`^${inArtifact}/v/\\d+/article/(.+)$`).exec(path);
    if (article) {
      const hash = built?.pages.find((page) => page.key === article[1])?.meta.htmlHash;
      const found = hash ? blob(hash) : null;
      return found
        ? new Response(Bun.file(found.path), { headers: { "Content-Type": "text/plain; charset=utf-8" } })
        : fail(404, "not_found", "Not found.");
    }
    const data = new RegExp(`^${inArtifact}/(data|files)/(shared|me)/?(.*)$`).exec(path);
    if (data) {
      const [, kind, scope, key] = data as unknown as [string, string, string, string];
      if (request.method === "PUT") return putData(request, kind, scope, decodeURIComponent(key));
      return dataRoute(request, kind, scope, decodeURIComponent(key)) ?? fail(405, "invalid", "No.");
    }
    if (path.startsWith("/__data/")) {
      const name = decodeURIComponent(path.slice("/__data/".length));
      if (!isDataKey(name)) return fail(404, "not_found", "Not found.");
      const file = join(dataDir, "files", name);
      return existsSync(file) ? new Response(Bun.file(file)) : fail(404, "not_found", "Not found.");
    }
    if (path.startsWith("/api/")) return fail(404, "not_found", "That isn't available locally.");
    const asset = assets.get(path) ?? assets.get("/index.html");
    if (!asset) return fail(404, "not_found", "Not found.");
    return new Response(asset.body, { headers: { "Content-Type": asset.type } });
  }

  /** The same sandbox and answers as the server, with env.DATA on .artifacts/data (08). */
  const data = fileStore(dataDir);
  let sandbox: ReturnType<Awaited<ReturnType<typeof sandboxHost>>["localSandbox"]> | null = null;
  async function backend(request: Request, path: string, search: string) {
    const host = await sandboxHost(out);
    if (request.method === "OPTIONS") return host.preflight();
    const source = built?.files.get(BACKEND_BUNDLE);
    if (!source) return new Response("No backend", { status: 404, headers: host.CORS });
    sandbox ??= host.localSandbox();
    const code = readFileSync(source.source, "utf8");
    const { response, logs } = await host.runBackend({
      run: sandbox.run,
      hash: source.hash,
      code: () => code,
      limits: DEFAULT_ORG_SETTINGS.limits,
      caller: LOCAL_CALLER,
      request: {
        method: request.method,
        path,
        search,
        contentType: request.headers.get("content-type"),
        body: await request.text(),
      },
      onData: host.localData(data),
    });
    for (const line of logs) out.say(`backend ${line.level}: ${line.message}`);
    return response;
  }

  /** Bundle files, under the same CSP the content host uses, so what works here works published. */
  function content(request: Request) {
    const refused = wrongHost(request, contentHosts);
    if (refused) return refused;
    const url = new URL(request.url);
    const api = new RegExp(`^/${secret}/v\\d+/api/(.*)$`).exec(url.pathname);
    if (api) return backend(request, api[1] as string, url.search);
    const match = new RegExp(`^/${secret}/v\\d+/(.*)$`).exec(new URL(request.url).pathname);
    const file = match ? built?.files.get(decodeURIComponent(match[1] as string)) : undefined;
    if (!file) return new Response("Not found", { status: 404 });
    return new Response(Bun.file(file.source), {
      headers: {
        "Content-Type": file.type,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src ${contentOrigin}; script-src ${contentOrigin} 'unsafe-inline'; style-src ${contentOrigin} 'unsafe-inline'; font-src ${contentOrigin}; img-src ${contentOrigin} data: blob: ${viewerOrigin}; media-src ${contentOrigin} blob:; connect-src ${contentOrigin}; frame-ancestors ${viewerOrigin}; base-uri 'none'; form-action 'none'; sandbox allow-scripts`,
      },
    });
  }

  await rebuild();
  Bun.serve({ port: flags.port, hostname: "localhost", fetch: handle });
  Bun.serve({ port: flags.port + 1, hostname: "127.0.0.1", fetch: content });

  // A change made while a rebuild runs is built once that one ends, so the last edit is always served.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let building = false;
  let dirty = false;
  const build = async () => {
    if (building) {
      dirty = true;
      return;
    }
    building = true;
    do {
      dirty = false;
      await rebuild().catch((error) => out.warn((error as Error).message));
    } while (dirty);
    building = false;
  };
  watch(root, { recursive: true }, (_event, name) => {
    const path = String(name ?? "");
    if (path.startsWith(LOCAL) || path.startsWith(".git") || path.startsWith("node_modules")) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(build, 200);
  });
  await new Promise(() => {});
}
