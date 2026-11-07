import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Artifact,
  CheckpointResult,
  LibraryView,
  PublishResult,
  SLUG_PATTERN,
  SUGGESTION_STATUSES,
  Tags,
  UNTRUSTED_NOTICE,
} from "@artifacts/schema";
import {
  BoardAssetsCommitted,
  BoardAssetsPrepared,
  BoardEditRequest,
  BoardEditResult,
  BoardPose,
  BoardRead,
  BoardState,
  BoardSuggestionList,
  BoardSuggestionPreview,
  BoardVersionView,
} from "@artifacts/schema/boards";
import { z } from "zod";
import { boardImage, imageExtension } from "../board/image.ts";
import { boardReadText, imageLine, snapshotOutline } from "../board/outline.ts";
import { ApiCallError, type Client } from "../client.ts";
import type { Input } from "../command.ts";
import { sha256 } from "../hash.ts";
import { CliError, type Output, UsageError } from "../output.ts";
import { signedIn } from "../session.ts";
import { namedArtifact, versionNumber } from "../target.ts";
import { delegate, editFailure, open, readStdinOrFile, usageFor } from "./page.ts";

type Server = { server?: string };
export type BoardFlags = Server & {
  json?: boolean;
  draft?: boolean;
  version?: string;
  cursor?: string;
  all?: boolean;
  text?: boolean;
  ops?: string;
  epoch?: string;
  "request-id"?: string;
  suggest?: boolean;
  checkpoint?: boolean;
  note?: string;
  source?: string[];
  fixes?: string;
  run?: string;
  agent?: string;
  frame?: string;
  near?: string;
  region?: string;
  side?: string;
  gap?: string;
  name?: string;
  message?: string;
  status?: string;
  preview?: string;
  goal?: string;
  finish?: string;
  cancel?: string;
  title?: string;
  summary?: string;
  tags?: string;
  sources?: string;
};

const SUBCOMMANDS = [
  "read",
  "edit",
  "suggest",
  "place-frame",
  "save",
  "suggestions",
  "delegate",
  "create",
  "asset",
  "export",
];
/** How many positionals each form takes after `board`: `asset add <artifact> <file>`, `export <artifact> <dir>`. */
const WORDS: Record<string, number> = { asset: 4, export: 3 };

/** Board text, labels and notes are other people's: JSON output says so, as page output does. */
const data = <T extends object>(result: T) => ({ untrusted: UNTRUSTED_NOTICE, ...result });

const HINTS: Record<string, string> = {
  stale_epoch: "The board was reset since that read. Read it again with --draft and use its epoch.",
  stale_read: "The board changed while it was being read. Read it again.",
  not_editable: "This page can't be edited as a board.",
};

/** The edit-scope message, and a next step for the conflicts an agent meets most. */
function boardFailure(error: unknown, out: Output): unknown {
  const failure = editFailure(error, out);
  if (out.json || !(failure instanceof ApiCallError)) return failure;
  const { code, details, message } = failure.failure;
  const reason = typeof details?.reason === "string" ? details.reason : null;
  if (code === "conflict" && reason && HINTS[reason]) {
    const why =
      reason === "not_editable" && typeof details?.editable === "string" ? ` (${details.editable})` : "";
    return new CliError(`${message} ${HINTS[reason]}${why}`);
  }
  return failure;
}

async function boards<T>(out: Output, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw boardFailure(error, out);
  }
}

const whole = (value: string, flag: string, what = "a whole number") => {
  if (!/^\d+$/.test(value) || Number(value) < 1)
    throw new UsageError(`${flag} wants ${what}, not "${value}".`);
  return Number(value);
};

const numbers = (value: string, flag: string) =>
  value
    .split(",")
    .filter(Boolean)
    .map((item) => {
      if (!/^\d+$/.test(item)) throw new UsageError(`${flag} wants thread numbers like 3,5, not "${value}".`);
      return Number(item);
    });

const slugs = (value: string | undefined, flag: string) => {
  const list = (value ?? "").split(",").filter(Boolean);
  if (!list.every((slug) => SLUG_PATTERN.test(slug))) throw new UsageError(`${flag} wants slugs like a,b.`);
  return list;
};

const issues = (error: z.ZodError) =>
  error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("\n");

/**
 * The request for `board edit` and `board suggest`: a `BoardEditRequest` from `--ops` (a file, or - for
 * standard input), or just its operations as a list. Flags fill what the file leaves out. A request id
 * the file doesn't have is made here, and printed, so a retry can reuse it.
 */
export function boardEditRequest(flags: BoardFlags, suggest: boolean): BoardEditRequest {
  if (flags.ops === undefined) throw new UsageError("Give --ops <file.json> (or - for standard input).");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readStdinOrFile(flags.ops, "the operations"));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`The operations aren't valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new UsageError("The operations are a JSON object (a board edit request) or a list of operations.");
  const request: Record<string, unknown> = Array.isArray(parsed) ? { ops: parsed } : { ...parsed };
  if (flags.epoch !== undefined)
    request.epoch = whole(flags.epoch, "--epoch", "the epoch board read printed");
  if (request.epoch === undefined)
    throw new UsageError("Give the epoch: --epoch <n> from board read --draft, or an epoch in the file.");
  request.requestId = flags["request-id"] ?? request.requestId ?? randomUUID();
  // An add-only batch has nothing to be stale about.
  request.bases ??= {};
  if (suggest) request.suggest = true;
  if (flags.checkpoint) request.checkpoint = true;
  if (flags.note !== undefined) request.note = flags.note;
  if (flags.source?.length) request.sources = flags.source;
  if (flags.fixes !== undefined) request.fixes = numbers(flags.fixes, "--fixes");
  if (flags.run !== undefined) request.run = flags.run;
  if (flags.agent !== undefined) request.agent = flags.agent;
  const checked = BoardEditRequest.safeParse(request);
  if (!checked.success) throw new UsageError(issues(checked.error));
  if (checked.data.suggest && checked.data.checkpoint)
    throw new UsageError("A suggestion changes nothing yet, so --checkpoint has nothing to save.");
  return checked.data;
}

const mark = { applied: "✓", suggested: "~", refused: "✗" } as const;

function receiptLines(result: BoardEditResult, requestId: string): string[] {
  const why = result.reason ? ` (${result.reason})` : "";
  const lines = [
    `${mark[result.outcome]} ${result.outcome}${why}${result.message ? `: ${result.message}` : ""}`,
  ];
  if (result.outcome !== "refused") {
    if (result.suggestion) lines.push(`  suggestion ${result.suggestion}`);
    for (const r of result.results) lines.push(`  op ${r.index}: ${r.objects.join(", ") || "no object"}`);
    const refs = Object.entries(result.ids);
    if (refs.length) lines.push(`  ids: ${refs.map(([ref, id]) => `${ref}=${id}`).join(" ")}`);
  }
  if (result.version !== null) lines.push(`✓ saved as v${result.version}`);
  if (result.outcome !== "applied") lines.push(`agents: ${result.agents.text}`);
  lines.push(`  request ${requestId}, seq ${result.seq}`);
  return lines;
}

/** Exit 0 when the batch was applied, 2 when it waits as a suggestion, 1 when it was refused (14, "CLI and skill"). */
async function submit(client: Client, artifact: Artifact, request: BoardEditRequest, out: Output) {
  const result = BoardEditResult.parse(
    await boards(out, () => client.post(`/api/artifacts/${artifact.id}/board/ops`, request)),
  );
  if (result.outcome === "refused") process.exitCode = 1;
  else if (result.outcome === "suggested") process.exitCode = 2;
  out.result(data({ ...result, requestId: request.requestId }), () => {
    for (const line of receiptLines(result, request.requestId)) out.say(line);
  });
}

function query(values: Record<string, string | boolean | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === true) params.set(key, "1");
    else if (typeof value === "string" && value) params.set(key, value);
  }
  return params.size > 0 ? `?${params}` : "";
}

/** Pages of a board read, one request each. The cursor binds the read, so a board that moved on is a conflict. */
async function* pages(
  client: Client,
  artifact: Artifact,
  params: { draft?: boolean; version?: string; cursor?: string },
) {
  let cursor = params.cursor;
  do {
    const page = BoardRead.parse(
      await client.get(`/api/artifacts/${artifact.id}/board/objects${query({ ...params, cursor })}`),
    );
    yield page;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

/** Every page of a read as one answer, for `--all`. Authors, images and suggestions repeat across pages once. */
async function readAll(client: Client, artifact: Artifact, params: { draft?: boolean; version?: string }) {
  let merged: BoardRead | undefined;
  for await (const page of pages(client, artifact, params)) {
    if (!merged) {
      merged = page;
      continue;
    }
    merged.objects.push(...page.objects);
    merged.frames.push(...page.frames);
    for (const image of page.assets)
      if (!merged.assets.some((have) => have.hash === image.hash)) merged.assets.push(image);
    for (const author of page.authors)
      if (!merged.authors.some((have) => have.key === author.key)) merged.authors.push(author);
    for (const s of page.suggestions)
      if (!merged.suggestions.some((have) => have.id === s.id)) merged.suggestions.push(s);
    merged.nextCursor = page.nextCursor;
  }
  if (!merged) throw new CliError("The server sent no board.");
  return merged;
}

/** The board's editing state, or the plain reason this CLI can't edit it. */
async function editableState(client: Client, artifact: Artifact) {
  const state = BoardState.parse(await client.get(`/api/artifacts/${artifact.id}/board`));
  if (!state.canEdit) throw new CliError("You can't edit this board. Ask for edit access, or comment on it.");
  if (!state.editable)
    throw new CliError(
      `This page can't be edited as a board (${state.reason ?? "not editable"}). Publish it again instead.`,
    );
  return state;
}

const SIDES = ["right", "below", "left", "above"] as const;

/**
 * `board place-frame`: read the draft, find the published frame and the object to put it beside, and send
 * one `place_frame` batch with the bases the read gave. The picture itself comes from `artifacts publish`.
 */
async function placeFrame(flags: BoardFlags, target: string, out: Output) {
  if (!flags.frame) throw new UsageError("Name the published frame with --frame <key>.");
  if ((flags.near === undefined) === (flags.region === undefined))
    throw new UsageError("Give --near <object id> or --region <x,y,w,h>, not both.");
  if (flags.side !== undefined && !(SIDES as readonly string[]).includes(flags.side))
    throw new UsageError(`--side is one of: ${SIDES.join(", ")}.`);
  if (flags.suggest && flags.checkpoint)
    throw new UsageError("A suggestion changes nothing yet, so --checkpoint has nothing to save.");
  let gap: number | undefined;
  if (flags.gap !== undefined) {
    gap = Number(flags.gap);
    if (!Number.isFinite(gap) || gap < 16 || gap > 2000) throw new UsageError("--gap is 16 to 2000 pixels.");
  }
  let region: BoardPose | undefined;
  if (flags.region !== undefined) {
    const [x, y, w, h, ...more] = flags.region.split(",").map(Number);
    const checked = BoardPose.safeParse({ x, y, w, h, angle: 0 });
    if (more.length > 0 || !checked.success)
      throw new UsageError("--region wants x,y,w,h in board pixels, such as 0,0,600,400.");
    region = checked.data;
  }
  const { client, artifact } = await open(flags, target);
  const state = await boards(out, () => editableState(client, artifact));

  // Bases are per object and the cursor binds the read, so one coherent pass; a board that moved restarts it.
  const bases = new Map<string, string>();
  let found: BoardRead["frames"][number] | undefined;
  let epoch = state.epoch;
  for (let attempt = 1; ; attempt++) {
    bases.clear();
    found = undefined;
    try {
      for await (const page of pages(client, artifact, { draft: true })) {
        epoch = page.epoch;
        for (const { object, base } of page.objects) bases.set(object.id, base);
        found ??= page.frames.find((frame) => frame.source.frame === flags.frame);
        if (found && (flags.near === undefined || bases.has(flags.near))) break;
      }
      break;
    } catch (error) {
      const stale = error instanceof ApiCallError && error.failure.details?.reason === "stale_read";
      if (!stale || attempt === 3) throw boardFailure(error, out);
    }
  }
  if (!found)
    throw new CliError(
      `No published frame "${flags.frame}" on this board. Run artifacts publish first, then place it.`,
    );
  if (found.placement === "deleted")
    throw new CliError(
      `Someone deleted "${flags.frame}" from the board on purpose. Publish a frame with a new key to put a new picture there.`,
    );
  if (found.placement === "suggested")
    throw new CliError(`"${flags.frame}" already waits in a suggestion. Accept or withdraw that first.`);
  if (flags.near !== undefined && !bases.has(flags.near))
    throw new CliError(`${flags.near} isn't an object on this board's draft. Run board read --draft.`);

  const neededBases: Record<string, string> = {};
  if (flags.near !== undefined) neededBases[flags.near] = bases.get(flags.near) as string;
  if (found.placement === "placed" && found.object && found.base) neededBases[found.object] = found.base;
  const request = BoardEditRequest.safeParse({
    epoch,
    requestId: flags["request-id"] ?? randomUUID(),
    bases: neededBases,
    ops: [
      {
        op: "place_frame",
        ...(found.placement === "unplaced" ? { ref: "$frame" } : {}),
        source: found.source,
        near: region ? { region } : { object: flags.near },
        side: flags.side ?? "right",
        ...(gap === undefined ? {} : { gap }),
      },
    ],
    ...(flags.suggest ? { suggest: true } : {}),
    ...(flags.checkpoint ? { checkpoint: true } : {}),
    ...(flags.note === undefined ? {} : { note: flags.note }),
    ...(flags.run === undefined ? {} : { run: flags.run }),
    ...(flags.agent === undefined ? {} : { agent: flags.agent }),
  });
  if (!request.success) throw new UsageError(issues(request.error));
  await submit(client, artifact, request.data, out);
}

/** `board asset add`: check the picture here, upload it straight to storage, and have the server validate it. */
async function addAsset(flags: BoardFlags, target: string, file: string, out: Output) {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(resolve(file));
  } catch (error) {
    throw new UsageError(`Can't read ${file}: ${(error as Error).message}`);
  }
  const image = boardImage(bytes, file);
  const { client, artifact } = await open(flags, target);
  const body = { images: [image] };
  const prepared = BoardAssetsPrepared.parse(
    await boards(out, () => client.post(`/api/artifacts/${artifact.id}/board/assets/prepare`, body)),
  );
  for (const upload of prepared.images) {
    // No URL means the server already holds these exact bytes for this board.
    if (!upload.url) continue;
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: bytes }).catch(
        () => null,
      );
      if (response?.ok || response?.status === 412) break;
      if (attempt === 3)
        throw new CliError(`Uploading the picture failed (${response?.status ?? "no connection"}).`);
      out.warn("Retrying the upload.");
      await Bun.sleep(500 * 2 ** attempt);
    }
  }
  const committed = BoardAssetsCommitted.parse(
    await boards(out, () => client.post(`/api/artifacts/${artifact.id}/board/assets/commit`, body)),
  );
  const [validated] = committed.images;
  if (!validated) throw new CliError("The server didn't accept that picture.");
  out.result(validated, () => {
    out.say(`✓ ${imageLine(validated)}`);
    out.warn(
      `Not placed yet. Add it with {"op":"add","ref":"$pic","object":{"kind":"image","asset":"${validated.hash}",…}} in board edit.`,
    );
  });
}

const FRAME_FILE = /[^a-z0-9-]+/g;

/** Where an export may go: a folder that doesn't exist yet, or one with nothing in it. */
function emptyFolder(dir: string) {
  const root = resolve(dir);
  if (existsSync(root) && readdirSync(root).length > 0)
    throw new CliError(`${root} isn't empty. Use another folder.`);
  mkdirSync(root, { recursive: true });
  return root;
}

export type BoardExport = {
  dir: string;
  version: number;
  hash: string;
  objects: number;
  assets: number;
  frames: number;
  skipped: string[];
};

/**
 * One checkpoint of a board as files (14, "CLI and skill"): `board.json` is the immutable schema-1 scene,
 * `outline.txt` reads it as plain text, `assets/<hash>.<ext>` holds its pictures and `frames/` the rendered
 * frames that have a picture. A draft is never exported. A picture that can't be fetched is listed, not fatal.
 */
export async function exportBoard(
  client: Client,
  artifact: Pick<Artifact, "id" | "project" | "slug" | "title">,
  dir: string,
  version?: string,
): Promise<BoardExport> {
  const view = BoardVersionView.parse(
    await client.get(`/api/artifacts/${artifact.id}/board/snapshot${query({ version })}`),
  );
  const root = emptyFolder(dir);
  const { snapshot } = view;
  const skipped: string[] = [];
  writeFileSync(join(root, "board.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(
    join(root, "outline.txt"),
    snapshotOutline(`${artifact.title}, v${view.version}`, snapshot, view.authors),
  );

  let assets = 0;
  for (const image of snapshot.assets) {
    try {
      const bytes = await client.redirected(
        `/api/artifacts/${artifact.id}/board/assets/${image.hash}?version=${view.version}`,
      );
      if (sha256(bytes) !== image.hash) throw new CliError("it doesn't match its hash");
      mkdirSync(join(root, "assets"), { recursive: true });
      writeFileSync(join(root, "assets", `${image.hash}.${imageExtension(image.type)}`), bytes);
      assets += 1;
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      skipped.push(`assets/${image.hash}: ${error.message}`);
    }
  }

  let frames = 0;
  for (const object of snapshot.objects) {
    if (object.kind !== "rendered_frame") continue;
    const { source } = object.data;
    const name = `${source.page}-${source.frame}`.toLowerCase().replace(FRAME_FILE, "-").slice(0, 80);
    try {
      const shown = LibraryView.parse(
        await client.get(
          `/api/library/projects/${artifact.project}/${artifact.slug}/view${query({ page: source.page, frame: source.frame, size: "2x", version: String(object.data.version) })}`,
        ),
      );
      if (!shown.image) throw new CliError("it has no picture");
      const bytes = await client.bytes(shown.image);
      mkdirSync(join(root, "frames"), { recursive: true });
      writeFileSync(join(root, "frames", `${name}.webp`), bytes);
      frames += 1;
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      skipped.push(`frames/${name}: ${error.message}`);
    }
  }
  return {
    dir: root,
    version: view.version,
    hash: view.hash,
    objects: snapshot.objects.length,
    assets,
    frames,
    skipped,
  };
}

export async function boardCommand(
  {
    args: { sub, target, third, fourth },
    rest,
    flags,
    usage,
  }: Input<"sub" | "target" | "third" | "fourth", BoardFlags>,
  out: Output,
) {
  if (!sub || !SUBCOMMANDS.includes(sub) || !target || rest.length !== (WORDS[sub] ?? 2))
    throw usage(Math.max(0, SUBCOMMANDS.indexOf(sub ?? "")));
  const bad = () => usage(SUBCOMMANDS.indexOf(sub));
  if (flags.version !== undefined) versionNumber(flags.version, "--version");

  if (sub === "asset") {
    usageFor(flags, [], bad);
    if (target !== "add") throw bad();
    namedArtifact(third);
    return addAsset(flags, third as string, fourth as string, out);
  }
  namedArtifact(target);

  if (sub === "read") {
    usageFor(flags, ["draft", "version", "cursor", "all", "text"], bad);
    if (flags.draft && flags.version) throw new UsageError("Use --draft or --version, not both.");
    if (flags.all && flags.cursor)
      throw new UsageError("--all reads from the start, so it takes no --cursor.");
    const { client, artifact } = await open(flags, target);
    const read = await boards(out, async () => {
      if (flags.all) return readAll(client, artifact, { draft: flags.draft, version: flags.version });
      return BoardRead.parse(
        await client.get(
          `/api/artifacts/${artifact.id}/board/objects${query({ draft: flags.draft, version: flags.version, cursor: flags.cursor })}`,
        ),
      );
    });
    // Without --text the answer is the structured read itself, with every id and base, in either mode.
    if (!flags.text) {
      console.log(JSON.stringify(data(read), null, 2));
      return;
    }
    return out.result(data(read), () => out.say(boardReadText(read)));
  }

  if (sub === "edit" || sub === "suggest") {
    usageFor(
      flags,
      ["ops", "epoch", "request-id", "suggest", "checkpoint", "note", "source", "fixes", "run", "agent"],
      bad,
    );
    if (sub === "suggest" && flags.suggest) throw bad();
    const request = boardEditRequest(flags, sub === "suggest" || flags.suggest === true);
    const { client, artifact } = await open(flags, target);
    return submit(client, artifact, request, out);
  }

  if (sub === "place-frame") {
    usageFor(
      flags,
      [
        "frame",
        "near",
        "region",
        "side",
        "gap",
        "suggest",
        "checkpoint",
        "note",
        "request-id",
        "run",
        "agent",
      ],
      bad,
    );
    return placeFrame(flags, target, out);
  }

  if (sub === "save") {
    usageFor(flags, ["epoch", "name", "message"], bad);
    const { client, artifact } = await open(flags, target);
    let epoch: number;
    if (flags.epoch !== undefined) epoch = whole(flags.epoch, "--epoch", "the epoch board read printed");
    else {
      const state = await boards(out, () => editableState(client, artifact));
      if (state.epoch < 1) throw new CliError("There's no draft to save yet. Edit the board first.");
      epoch = state.epoch;
    }
    const result = CheckpointResult.parse(
      await boards(out, () =>
        client.post(`/api/artifacts/${artifact.id}/board/checkpoint`, {
          epoch,
          name: flags.name,
          message: flags.message,
        }),
      ),
    );
    return out.result({ ...result, pictures: "pending" }, () => {
      out.say(
        result.created
          ? `✓ v${result.version} saved`
          : `Nothing new to save. v${result.version} is the latest.`,
      );
      // This CLI has no browser: the picture of a saved board is drawn the next time someone opens it in one.
      if (result.created)
        out.say("  pictures pending: a browser fills them in when someone opens the board.");
    });
  }

  if (sub === "suggestions") {
    usageFor(flags, ["status", "cursor", "preview"], bad);
    if (
      flags.status &&
      flags.status !== "all" &&
      !(SUGGESTION_STATUSES as readonly string[]).includes(flags.status)
    )
      throw new UsageError(`--status is one of: ${[...SUGGESTION_STATUSES, "all"].join(", ")}.`);
    if (flags.preview && !z.uuid().safeParse(flags.preview).success)
      throw new UsageError("--preview wants a suggestion id.");
    if (flags.preview && flags.status) throw new UsageError("Use --preview or --status, not both.");
    const { client, artifact } = await open(flags, target);
    if (flags.preview) {
      const preview = BoardSuggestionPreview.parse(
        await boards(out, () =>
          client.get(`/api/board-suggestions/${flags.preview}/preview${query({ cursor: flags.cursor })}`),
        ),
      );
      return out.result(data(preview), () => {
        out.say(`Ghost objects of ${preview.id} (epoch ${preview.epoch}, seq ${preview.seq}):`);
        for (const { object, base } of preview.objects)
          out.say(`  ${object.id} ${object.kind} base=${base} label=${JSON.stringify(object.label)}`);
        if (preview.deleted.length) out.say(`  would delete: ${preview.deleted.join(", ")}`);
        if (preview.nextCursor) out.say(`More: --preview ${preview.id} --cursor ${preview.nextCursor}`);
      });
    }
    const list = BoardSuggestionList.parse(
      await boards(out, () =>
        client.get(
          `/api/artifacts/${artifact.id}/board/suggestions${query({ status: flags.status === "all" ? undefined : flags.status, cursor: flags.cursor })}`,
        ),
      ),
    );
    return out.result(data(list), () => {
      if (list.suggestions.length === 0) out.say("No suggestions.");
      for (const s of list.suggestions) {
        const by =
          s.author.kind === "agent"
            ? `${s.author.agent ?? "an agent"} for ${s.author.for ?? "an organization"}`
            : s.author.name;
        out.say(
          `  ${s.id}  ${s.status}  ${s.request.ops.map((op) => op.op).join(", ")}, by ${by}${s.note ? ` (${s.note})` : ""}`,
        );
      }
      if (list.nextCursor) out.say(`More: --cursor ${list.nextCursor}`);
    });
  }

  if (sub === "delegate") {
    usageFor(flags, ["goal", "agent", "finish", "cancel", "message"], bad);
    return delegate(flags, target, out, { edit: "board edit", bad });
  }

  if (sub === "export") {
    usageFor(flags, ["version"], bad);
    if (!third) throw bad();
    const { client, artifact } = await open(flags, target);
    const done = await boards(out, () => exportBoard(client, artifact, third, flags.version));
    return out.result(done, () => {
      out.say(
        `✓ v${done.version}: ${done.objects} objects, ${done.assets} pictures, ${done.frames} frames in ${done.dir}`,
      );
      for (const item of done.skipped) out.warn(`! Left out ${item}`);
    });
  }

  // create
  usageFor(flags, ["title", "summary", "tags", "sources"], bad);
  const [wiki, slug] = target.split("/");
  if (!flags.title || !flags.summary) throw new UsageError("Give --title and --summary.");
  const tags = Tags.safeParse((flags.tags ?? "").split(",").filter(Boolean));
  if (!tags.success) throw new UsageError("--tags: up to 8, each up to 32 characters, such as a,b.");
  const sources = slugs(flags.sources, "--sources");
  const client = await signedIn(flags.server);
  const created = PublishResult.parse(
    await boards(out, () =>
      client.post("/api/boards", {
        project: wiki,
        slug,
        title: flags.title,
        summary: flags.summary,
        ...(tags.data.length ? { tags: tags.data } : {}),
        ...(sources.length ? { sources } : {}),
      }),
    ),
  );
  out.result(created, () => out.say(`✓ ${wiki}/${slug} v${created.version}  ${created.url}`));
}
