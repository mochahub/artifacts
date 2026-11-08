// Bun-only fixture publisher. Capture the real CLI's prepared content once in claim setup;
// browser behavior tests can publish independent artifacts without re-rendering identical frames.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "../../../packages/cli/src/client.ts";
import { createOutput } from "../../../packages/cli/src/output.ts";
import { collectForPublish, publishBody, uploadFiles } from "../../../packages/cli/src/publish.ts";

const [cache, mode, value, title] = process.argv.slice(2);
const client = new Client(process.env.ARTIFACTS_URL, process.env.ARTIFACTS_TOKEN);
const out = createOutput(true);
if (mode === "capture") {
  const { manifest, rendered } = await collectForPublish(process.cwd(), out, undefined, client);
  const body = publishBody(rendered, manifest, { message: value, notes: {} });
  const prepare = {
    project: manifest.project,
    projectName: manifest.projectName,
    repo: null,
    slug: manifest.slug,
    title: manifest.title,
    visibility: manifest.visibility,
    files: body.declared,
  };
  const prepared = await client.post("/api/publish/prepare", prepare);
  await uploadFiles(prepared.missing, body.sources, out);
  await client.post("/api/publish/commit", { uploadId: prepared.uploadId, ...body.commit });
  const directory = `${cache}.files`;
  mkdirSync(directory, { recursive: true });
  for (const [hash, source] of body.sources) {
    const destination = join(directory, hash);
    copyFileSync(source, destination);
    body.sources.set(hash, destination);
  }
  await Bun.write(cache, JSON.stringify({ prepare, commit: body.commit, sources: [...body.sources] }));
} else {
  for (const file of JSON.parse(await Bun.file(cache).text())) {
    const { prepare, commit, sources } = await Bun.file(file).json();
    const prepared = await client.post("/api/publish/prepare", { ...prepare, slug: value, title });
    await uploadFiles(prepared.missing, new Map(sources), out);
    await client.post("/api/publish/commit", { uploadId: prepared.uploadId, ...commit });
  }
}
