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
import { isDataKey } from "@artifacts/schema";
import { findRoot, loadManifest } from "../bundle/manifest.ts";
import { viewerAssets } from "../dev/assets.ts";
import { staticLint } from "../lint/static.ts";
import { CliError, type Output } from "../output.ts";
import { ensureHelper } from "../render/install.ts";
import { type RenderResult, render } from "../render/render.ts";

const ID = "00000000-0000-7000-8000-00000000d0d0";
const PERSON = {
  id: "00000000-0000-7000-8000-00000000d0d1",
  name: "You",
  email: "you@localhost",
  role: "owner",
};

/** What the server lets a backend set; the rest never reaches the browser. */
const SAFE_HEADERS = new Set(["content-type", "etag", "last-modified"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, code: string, message: string) =>
  json({ error: { code, message, details: {} } }, status);

/**
 * `artifacts dev` (07): the real viewer, on this machine, over a small local API. Nothing leaves the
 * machine, comments are off, and saved data lives in .artifacts/data/. Each change renders again as
 * the next version, so an open viewer picks it up on its next poll.
 */
export async function devCommand(flags: { port: number }, out: Output) {
  const root = findRoot();
  const assets = await viewerAssets();
  if (assets.size === 0) throw new CliError("The viewer isn't built. Run: bun run build");
  const viewerOrigin = `http://localhost:${flags.port}`;
  const contentOrigin = `http://127.0.0.1:${flags.port + 1}`;
  const dataDir = join(root, ".artifacts/data");
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

  const card = () => ({
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

  const artifact = () => ({
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
        : json({ keys: entries, nextCursor: null });
    }
    if (request.method === "GET") {
      if (!existsSync(path)) return fail(404, "not_found", "Not found.");
      if (kind === "files") return json({ url: `${viewerOrigin}/__data/${scope}/${key}` });
      return json({ value: JSON.parse(readFileSync(path, "utf8")), etag: etagOf(path) });
    }
    if (request.method === "DELETE") {
      rmSync(path, { force: true });
      return json({ ok: true });
    }
    return null;
  }

  const etagOf = (path: string) =>
    existsSync(path) ? String(Math.floor(statSync(path).mtimeMs * 1000)) : "";

  /** A key names a place in the data folder, so a bundle someone else wrote can't leave it. */
  const inData = (path: string) => {
    const full = resolve(path);
    if (!full.startsWith(resolve(dataDir) + sep)) throw new CliError("Keys stay in the data folder.");
    return full;
  };

  async function putData(request: Request, kind: string, scope: string, key: string) {
    if (!isDataKey(key)) return fail(400, "invalid", "That isn't a valid key.");
    const path = join(dataDir, kind === "files" ? "files" : "", scope, key);
    const ifMatch = request.headers.get("if-match");
    if (ifMatch && etagOf(path) !== ifMatch) return fail(412, "precondition_failed", "Someone wrote first.");
    if (request.headers.get("if-none-match") === "*" && existsSync(path)) {
      return fail(412, "precondition_failed", "Someone wrote first.");
    }
    mkdirSync(dirname(path), { recursive: true });
    if (kind === "files") writeFileSync(path, new Uint8Array(await request.arrayBuffer()));
    else writeFileSync(path, JSON.stringify(((await request.json()) as { value: unknown }).value));
    return json({ etag: etagOf(path), name: key });
  }

  async function handle(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const inArtifact = `/api/artifacts/${ID}`;
    if (path === "/api/meta") {
      return json({
        version: "dev",
        minCliVersion: "0.0.0",
        orgName: "Local",
        homeDomain: "localhost",
        publicUrl: viewerOrigin,
        contentUrl: contentOrigin,
        viewerOrigins: [viewerOrigin],
      });
    }
    if (path === "/api/me") return json({ person: PERSON, org: { name: "Local" }, recentAuth: false });
    if (path === "/api/home") return json({ waiting: [card()], recent: [] });
    if (path === "/api/projects") {
      return json([
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
      return json({ project: { slug: project, name: project, repo: null }, artifacts: [card()] });
    }
    if (path === `/api/artifacts/by-slug/${project}/${slug}` || path === inArtifact) return json(artifact());
    if (path === `${inArtifact}/threads`) return json([]);
    if (path === `${inArtifact}/seen`) return json({ ok: true });
    if (path === `${inArtifact}/versions`) {
      return json([
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
      return json({
        base: `${contentOrigin}/v${version}/`,
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
    const article = new RegExp(`^${inArtifact}/v/\\\\d+/article/(.+)$`).exec(path);
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

  /** The same sandbox as the server, with env.DATA on .artifacts/data (08). */
  type Child = {
    up: Promise<void>;
    run(
      options: unknown,
    ): Promise<{ response?: SandboxResponse; logs?: { level: string; message: string }[] }>;
  };
  type SandboxResponse = { status: number; headers: [string, string][]; body: string };
  let sandbox: Child | null = null;
  let requests = 0;
  async function backend(request: Request, path: string) {
    const source = built?.files.get("__backend.js");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!source) return new Response("No backend", { status: 404, headers: CORS });
    const dir = ensureHelper(out);
    // From the helper folder, not bundled: the binary embeds this file as text for that folder (07).
    const { startChild } = await import(join(dir, "sandbox-host.js"));
    sandbox ??= startChild({
      childPath: join(dir, "sandbox-child.js"),
      prelude: readFileSync(join(dir, "sandbox-prelude.js"), "utf8"),
      onExit: () => {
        sandbox = null;
      },
    });
    const child = sandbox as Child;
    await child.up;
    const code = readFileSync(source.source, "utf8");
    const { response, logs } = await child.run({
      id: ++requests,
      hash: source.hash,
      code: () => code,
      limits: { timeoutMs: 10_000, memoryMb: 64 },
      request: {
        url: `https://backend.invalid/api/${path}`,
        method: request.method,
        headers: {
          "content-type": request.headers.get("content-type") ?? "",
          "x-caller": JSON.stringify({
            id: "local",
            name: "You",
            kind: "owner",
            canComment: true,
            isPublisher: true,
          }),
        },
        body: await request.text(),
      },
      onData: async (raw: string) => {
        const op = JSON.parse(raw) as {
          op: string;
          key?: string;
          prefix?: string;
          value?: unknown;
          ifMatch?: string;
        };
        const named = op.op === "list" ? op.prefix || "shared/" : (op.key ?? "");
        if (!isDataKey(named)) return { error: { code: "invalid", message: "That isn't a valid key." } };
        const key = /^(shared|me|files)\//.test(named) ? named : `shared/${named}`;
        const file = inData(join(dataDir, key));
        if (op.op === "list") {
          const bare = !op.prefix || key !== named;
          const stored = existsSync(dataDir) ? [...new Bun.Glob("**/*").scanSync(dataDir)] : [];
          const keys = stored
            .filter((name) => name.startsWith(key))
            .map((name) => (bare ? name.slice("shared/".length) : name));
          return { value: { keys, nextCursor: null } };
        }
        if (op.op === "get") {
          if (!existsSync(file)) return { value: null };
          return { value: { value: JSON.parse(readFileSync(file, "utf8")), etag: etagOf(file) } };
        }
        if (op.ifMatch && (op.ifMatch === "*" ? existsSync(file) : etagOf(file) !== op.ifMatch)) {
          return { error: { code: "precondition_failed", message: "Someone wrote first." } };
        }
        if (op.op === "put") {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, JSON.stringify(op.value));
          return { value: { etag: etagOf(file) } };
        }
        if (op.op === "delete") rmSync(file, { force: true });
        return { value: true };
      },
    });
    for (const line of logs ?? []) out.say(`backend ${line.level}: ${line.message}`);
    if (!response) return new Response('{"error":"The sandbox stopped."}', { status: 502, headers: CORS });
    const safe = (response.headers as [string, string][]).filter(([name]) =>
      SAFE_HEADERS.has(name.toLowerCase()),
    );
    return new Response(response.body, {
      status: response.status,
      headers: { ...CORS, "Cache-Control": "no-store", ...Object.fromEntries(safe) },
    });
  }

  /** Bundle files, under the same CSP the content host uses, so what works here works published. */
  function content(request: Request) {
    const api = /^\/v\d+\/api\/(.*)$/.exec(new URL(request.url).pathname);
    if (api) return backend(request, api[1] as string);
    const match = /^\/v\d+\/(.*)$/.exec(new URL(request.url).pathname);
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

  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  watch(root, { recursive: true }, (_event, name) => {
    const path = String(name ?? "");
    if (path.startsWith(".artifacts") || path.startsWith(".git") || path.startsWith("node_modules")) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (busy) return;
      busy = true;
      await rebuild().catch((error) => out.warn((error as Error).message));
      busy = false;
    }, 200);
  });
  await new Promise(() => {});
}
