import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { extname, join } from "node:path";
import { LibrarianInbox, Slug, SourceInput } from "@artifacts/schema";
import { z } from "zod";
import { ApiCallError, type Client } from "../client.ts";
import { configDir, writePrivateFile } from "../config.ts";
import { CliError, type Output } from "../output.ts";
import { signedIn } from "../session.ts";

class SourceValidationError extends ApiCallError {
  constructor(message: string) {
    super({ code: "invalid", status: 400, message, details: {} });
  }
}

export const SourceSubmission = z
  .object({
    wiki: Slug,
    source: SourceInput,
    requestId: z.uuid(),
    note: z.string().max(2000).optional(),
  })
  .strict();
export type SourceFlags = {
  file?: string;
  "text-file"?: string;
  url?: string;
  title?: string;
  note?: string;
  "request-id"?: string;
  server?: string;
};
export async function submitSource(client: Client, raw: unknown) {
  const parsed = SourceSubmission.safeParse(raw);
  if (!parsed.success)
    throw new SourceValidationError(
      "Invalid source submission: " +
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  const { wiki, source, requestId, note } = parsed.data;
  const response = await client.post<Record<string, unknown>>(`/api/wikis/${wiki}/inbox`, {
    source,
    idempotencyKey: requestId,
    ...(note === undefined ? {} : { note }),
  });
  const { message, ...item } = response;
  return {
    ...LibrarianInbox.parse(item),
    requestId,
    message: typeof message === "string" ? message : "Saved to inbox; processing is not complete.",
  };
}
function readOwned(path: string, max: number) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > max) throw new Error();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) throw new Error();
      const buffer = Buffer.alloc(max + 1);
      let length = 0;
      while (length <= max) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length < 1 || length > max) throw new Error();
      return buffer.subarray(0, length);
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new SourceValidationError(
      "Source must be a readable regular file within the size limit (no symlinks).",
    );
  }
}
export async function addSourceCommand(wiki: string, flags: SourceFlags, out: Output) {
  const requestId = flags["request-id"] ?? randomUUID();
  if (
    !Slug.safeParse(wiki).success ||
    !z.uuid().safeParse(requestId).success ||
    (flags.note?.length ?? 0) > 2000 ||
    [flags.file, flags["text-file"], flags.url].filter((v) => v !== undefined).length !== 1
  )
    throw new SourceValidationError(
      "Choose one of --file, --text-file or --url, a wiki slug, a UUID request id and a note of at most 2000 characters.",
    );
  let source: z.infer<typeof SourceInput>;
  let bytes: Buffer | undefined;
  let mime = "";
  if (flags.file !== undefined) {
    mime =
      (
        {
          ".txt": "text/plain",
          ".md": "text/markdown",
          ".html": "text/html",
          ".htm": "text/html",
          ".pdf": "application/pdf",
        } as Record<string, string>
      )[extname(flags.file).toLowerCase()] ?? "";
    if (!mime)
      throw new SourceValidationError("Supported files: UTF-8 text, Markdown, HTML and text-bearing PDF.");
    bytes = readOwned(flags.file, 10485760);
    source = {
      kind: "file",
      uploadId: requestId,
      ...(flags.title === undefined ? {} : { title: flags.title }),
    };
  } else if (flags["text-file"] !== undefined) {
    if (!flags.title?.trim()) throw new SourceValidationError("--text-file requires --title.");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(readOwned(flags["text-file"], 1048576));
    } catch (e) {
      if (e instanceof SourceValidationError) throw e;
      throw new SourceValidationError("Text must be valid UTF-8.");
    }
    source = { kind: "text", text, title: flags.title };
  } else
    source = {
      kind: "url",
      url: flags.url ?? "",
      ...(flags.title === undefined ? {} : { title: flags.title }),
    };
  if (!SourceInput.safeParse(source).success)
    throw new SourceValidationError("Invalid source: check HTTPS URL and title (at most 256 characters).");
  const client = await signedIn(flags.server);
  out.say(`Request id: ${requestId}`);
  if (bytes) {
    const cacheKey = createHash("sha256")
      .update(JSON.stringify([client.url, client.token, wiki, requestId]))
      .digest("hex");
    const cache = join(configDir(), "source-requests", `${cacheKey}.json`);
    const digest = createHash("sha256")
      .update(bytes)
      .update(JSON.stringify([mime, flags.title, flags.note]))
      .digest("hex");
    let uploadId: string;
    if (existsSync(cache)) {
      const prior = z
        .object({ digest: z.string(), uploadId: z.uuid() })
        .parse(JSON.parse(readFileSync(cache, "utf8")));
      if (prior.digest !== digest)
        throw new SourceValidationError(
          "Request id was already used for different source bytes or metadata.",
        );
      uploadId = prior.uploadId;
    } else {
      const ticket = z
        .object({ uploadId: z.uuid(), url: z.url(), headers: z.record(z.string(), z.string()) })
        .parse(
          await client.post(`/api/wikis/${wiki}/inbox/uploads`, {
            name: `source${extname(flags.file ?? "").toLowerCase()}`,
            size: bytes.length,
            contentType: mime,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }),
        );
      const target = new URL(ticket.url);
      if (
        target.protocol !== "https:" &&
        !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
      )
        throw new CliError("Invalid upload destination.");
      const uploaded = await fetch(ticket.url, {
        method: "PUT",
        headers: ticket.headers,
        body: bytes,
        redirect: "manual",
        signal: AbortSignal.timeout(60000),
      });
      if (!uploaded.ok) throw new CliError("Quarantine upload failed.");
      uploadId = ticket.uploadId;
      writePrivateFile(cache, JSON.stringify({ digest, uploadId }));
    }
    source = { ...source, kind: "file", uploadId } as z.infer<typeof SourceInput>;
  }
  const result = await submitSource(client, {
    wiki,
    source,
    requestId,
    ...(flags.note === undefined ? {} : { note: flags.note }),
  });
  out.result(result, () => out.say(`${result.message}\nInbox ${result.id}: ${result.status}`));
}
