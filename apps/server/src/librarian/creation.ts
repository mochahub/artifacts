import { createHash } from "node:crypto";
import { buildArticle } from "@artifacts/schema/article";
import { articleHtmlPath, MANIFEST } from "@artifacts/schema/bundle";
import { sanitizeArticle } from "@artifacts/schema/sanitize";
import { and, eq } from "drizzle-orm";
import { findArtifact, toProject } from "../auth/access.ts";
import { actorOf, type Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import type { Tx } from "../db/index.ts";
import { artifacts, librarianInbox, librarianProposals, projects } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { blobKey } from "../layout.ts";
import { putBlob } from "../publish/blobs.ts";
import { createArtifactLocked, type VersionInput } from "../publish/publisher.ts";
import {
  authorize,
  currentSubmitter,
  type ExtractedSource,
  type Submission,
  type TrustedSourceCreator,
} from "./ingestion/index.ts";
import { reviewProposal } from "./proposals.ts";

const missing = () => new ApiError("not_found", "Not found.");
const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
/** Content-addressed unreferenced stages use the ordinary blob GC grace period. Never delete a
 * shared hash on rollback: another transaction may have committed a reference to it. */
async function stage(deps: Deps, orgId: string, bytes: Uint8Array, type: string) {
  const hash = await putBlob(deps, orgId, bytes, type);
  const stored = await deps.bucket.get(blobKey(hash));
  if (!stored || createHash("sha256").update(stored.body).digest("hex") !== hash)
    throw new ApiError("invalid", "Staged content failed verification.");
  return { hash, size: bytes.length, type };
}
function textBlocks(value: string): VersionInput["blocks"] {
  const characters = [...value.replace(/\r\n?/g, "\n")];
  return Array.from({ length: Math.ceil(characters.length / 2048) }, (_, index) => {
    const text = characters.slice(index * 2048, (index + 1) * 2048).join("");
    return {
      pageKey: "index",
      blockKey: `source-${String(index).padStart(6, "0")}`,
      contentHash: createHash("sha256").update(text).digest("hex"),
      text,
    };
  });
}
async function wiki(deps: Deps, tx: Tx, orgId: string, wikiId: string, caller: Caller) {
  const scoped = { ...deps, db: tx } as unknown as Deps;
  const [row] = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.id, wikiId), eq(projects.orgId, orgId)));
  if (row?.kind !== "wiki" || !can(caller, "project.publish", await toProject(scoped, row))) throw missing();
  if (caller.kind === "orgToken" && !caller.projectIds?.includes(wikiId)) throw missing();
  return scoped;
}
function version(
  deps: Deps,
  orgId: string,
  projectId: string,
  title: string,
  file: Awaited<ReturnType<typeof stage>>,
): VersionInput {
  return {
    artifactId: crypto.randomUUID(),
    orgId,
    projectId,
    title,
    files: { "index.html": file },
    backendHash: null,
    message: null,
    name: null,
    notes: {},
    summary: null,
    tags: null,
    wiki: { role: "page", sources: [], untrusted: true },
    links: [],
    pages: [
      { key: "index", title, kind: "article", position: 0, group: null, meta: { htmlHash: file.hash } },
    ],
    frames: [],
    blocks: [],
    checkpoint: null,
    docSeq: null,
    now: deps.clock.now(),
  };
}
export async function createReviewedProposal(
  deps: Deps,
  input: {
    orgId: string;
    wikiId: string;
    proposalId: string;
    caller: Caller;
    requestId: string;
  },
) {
  const caller = input.caller;
  if (caller.kind !== "person") throw missing();
  const [p] = await deps.db
    .select()
    .from(librarianProposals)
    .where(
      and(
        eq(librarianProposals.id, input.proposalId),
        eq(librarianProposals.orgId, input.orgId),
        eq(librarianProposals.wikiId, input.wikiId),
      ),
    );
  if (!p) throw missing();
  const authorizeProposal = async (tx: Tx, current: typeof p) => {
    const scoped = await wiki(deps, tx, input.orgId, input.wikiId, caller);
    for (const id of [
      ...current.sources,
      ...(current.createdArtifactId ? [current.createdArtifactId] : []),
    ]) {
      const source = await findArtifact(scoped, input.orgId, id);
      if (!source || source.project.id !== input.wikiId || !can(caller, "artifact.read", source))
        throw missing();
    }
  };
  // Check visibility before touching storage; recheck under review's row lock before replay/create.
  await deps.db.transaction((tx) => authorizeProposal(tx, p));
  const built = buildArticle({
    source: p.markdown,
    path: "index.md",
    readFile: () => "",
    blobHash: () => undefined,
    frameHash: () => undefined,
    mermaid: new Map(),
  });
  if (built.problems.some((problem) => problem.severity === "error"))
    throw new ApiError("invalid", "Invalid proposed article.");
  const file =
    p.status === "open"
      ? await stage(deps, input.orgId, Buffer.from(sanitizeArticle(built.html)), "text/html; charset=utf-8")
      : undefined;
  const markdown =
    p.status === "open"
      ? await stage(deps, input.orgId, Buffer.from(p.markdown), "text/markdown")
      : undefined;
  const manifest =
    p.status === "open"
      ? await stage(
          deps,
          input.orgId,
          Buffer.from(
            JSON.stringify({
              title: p.title,
              pages: [{ id: "index", title: p.title, kind: "article", src: "index.md" }],
            }),
          ),
          "application/json",
        )
      : undefined;
  return reviewProposal(
    deps,
    { ...input, personId: caller.person.id, requestId: input.requestId },
    authorizeProposal,
    async (tx, current) => {
      if (!file || current.markdown !== p.markdown)
        throw new ApiError("conflict", "Proposal changed. Retry review.");
      const scoped = { ...deps, db: tx } as unknown as Deps;
      const sources: string[] = [];
      for (const id of current.sources) {
        const source = await findArtifact(scoped, input.orgId, id);
        if (!source) throw missing();
        sources.push(source.row.slug);
      }
      const content = version(deps, input.orgId, input.wikiId, current.title, file);
      content.wiki = { role: "page", sources, untrusted: true };
      if (!markdown || !manifest) throw missing();
      content.files = { [articleHtmlPath("index")]: file, "index.md": markdown, [MANIFEST]: manifest };
      content.pages[0]!.meta = {
        htmlHash: file.hash,
        outline: built.outline,
        readingMinutes: built.readingMinutes,
      };
      content.blocks = built.blocks.map((block) => ({ pageKey: "index", ...block }));
      await createArtifactLocked(
        tx,
        { ...content, slug: `prop-${current.id.replaceAll("-", "")}`, visibility: "me" },
        { personId: caller.person.id, agent: null },
      );
      return { artifactId: content.artifactId, result: { artifactId: content.artifactId } };
    },
  );
}
/** Trusted ingestion construction only. Stages exact extraction bytes before entering its fence. */
export async function createImmutableSource(
  deps: Deps,
  input: Submission,
  source: ExtractedSource,
  inboxId: string,
): Promise<TrustedSourceCreator> {
  await authorize(deps, input);
  if (input.caller.kind === "orgToken" && !input.caller.projectIds?.includes(input.wikiId)) throw missing();
  const [inbox] = await deps.db
    .select()
    .from(librarianInbox)
    .where(
      and(
        eq(librarianInbox.id, inboxId),
        eq(librarianInbox.orgId, input.orgId),
        eq(librarianInbox.wikiId, input.wikiId),
      ),
    );
  if (!inbox) throw missing();
  const metadata = await stage(
    deps,
    input.orgId,
    Buffer.from(
      JSON.stringify({
        hash: source.hash,
        submittedBy: inbox.submittedBy,
        receivedAt: inbox.submittedAt,
        input: inbox.input,
        extractionVersion: source.extractionVersion,
        untrusted: true,
      }),
    ),
    "application/json",
  );
  const original = await stage(deps, input.orgId, source.bytes, source.mime);
  if (original.hash !== source.hash) throw new ApiError("invalid", "Source hash changed.");
  const html = await stage(
    deps,
    input.orgId,
    Buffer.from(
      sanitizeArticle(`<pre><span>${escapeHtml(source.text.replace(/\r\n?/g, "\n"))}</span></pre>`),
    ),
    "text/html; charset=utf-8",
  );
  return async (tx, extracted, inbox) => {
    if (extracted !== source || inbox.orgId !== input.orgId || inbox.wikiId !== input.wikiId) throw missing();
    input = {
      ...input,
      caller: await currentSubmitter({ ...deps, db: tx } as unknown as Deps, input, inbox),
    };
    const scoped = await wiki(deps, tx, input.orgId, input.wikiId, input.caller);
    await authorize(scoped, input);
    if (
      input.caller.kind !== "person" &&
      input.caller.kind !== "cliToken" &&
      input.caller.kind !== "orgToken"
    )
      throw missing();
    const content = version(deps, input.orgId, input.wikiId, inbox.title ?? "Source", html);
    // Text rows carry exact extraction text (including Unicode), independent of HTML sanitization.
    // Fixed small chunks make every byte available through bounded source_read continuations.
    content.blocks = textBlocks(source.text);
    content.files.original = original;
    content.files["__librarian_source.json"] = metadata;
    content.wiki = { role: "source", sources: [], untrusted: true };
    await createArtifactLocked(
      tx,
      {
        ...content,
        slug: `source-${inbox.id.replaceAll("-", "")}`,
        visibility: input.caller.kind === "orgToken" ? "org" : "me",
      },
      { personId: actorOf(input.caller), agent: "Librarian" },
    );
    await tx
      .update(artifacts)
      .set({ archivedAt: deps.clock.now() })
      .where(eq(artifacts.id, content.artifactId));
    return content.artifactId;
  };
}
