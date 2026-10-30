import { isDataKey } from "@artifacts/schema";
import { type Output, UsageError } from "../output.ts";
import { signedIn } from "./account.ts";
import { resolveArtifact, versionNumber } from "./review.ts";

type ListPage = { keys: { key: string; size: number; updatedAt: string }[]; nextCursor: string | null };

type LogLine = { id: string; version: number; level: string; message: string; createdAt: string };

/** `artifacts logs` (07): the last 24 hours, and then whatever arrives. */
export async function logsCommand(
  flags: { follow?: boolean; version?: string; server?: string },
  out: Output,
) {
  if (flags.version) versionNumber(flags.version, "--version");
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, undefined);
  const query = flags.version ? `version=${flags.version}&` : "";
  let after = "";
  for (;;) {
    const lines = await client.get<LogLine[]>(`/api/artifacts/${artifact.id}/logs?${query}after=${after}`);
    if (!flags.follow) return out.result(lines, () => print(lines, out));
    print(lines, out);
    after = lines.at(-1)?.id ?? after;
    await Bun.sleep(2000);
  }
}

const print = (lines: LogLine[], out: Output) => {
  for (const line of lines)
    out.say(`${line.createdAt.slice(11, 19)} v${line.version} ${line.level}  ${line.message}`);
};

export async function dataCommand(
  sub: string | undefined,
  key: string | undefined,
  flags: { scope?: string; server?: string; target?: string },
  out: Output,
) {
  const scope = flags.scope ?? "shared";
  if (scope !== "shared" && scope !== "me") throw new UsageError("--scope is shared or me.");
  // A key with a ".." part would climb out of the data/ path in the URL.
  if (sub === "get" && key && !isDataKey(key)) throw new UsageError(`"${key}" isn't a valid data key.`);
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, flags.target);
  const base = `/api/artifacts/${artifact.id}`;
  switch (sub) {
    case "ls": {
      const keys: ListPage["keys"] = [];
      let cursor = "";
      do {
        const page = await client.get<ListPage>(`${base}/data/${scope}?cursor=${encodeURIComponent(cursor)}`);
        keys.push(...page.keys);
        cursor = page.nextCursor ?? "";
      } while (cursor);
      return out.result(keys, () => {
        if (keys.length === 0) out.say("Nothing saved.");
        for (const entry of keys) out.say(`${entry.key}  ${entry.size} bytes`);
      });
    }
    case "get": {
      if (!key) throw new UsageError("Usage: artifacts data get <key> [--scope shared|me]");
      const { value } = await client.get<{ value: unknown }>(`${base}/data/${scope}/${key}`);
      return out.result(value, () => out.say(JSON.stringify(value, null, 2)));
    }
    case "export": {
      const body = await client.get<unknown>(`${base}/data-export`);
      // Always JSON, because it's meant to be piped: artifacts data export > data.json
      return console.log(JSON.stringify(body, null, 2));
    }
    case "clear": {
      await client.post(`${base}/data-clear`, flags.scope ? { scope } : {});
      return out.result({ ok: true }, () => out.say(`✓ Cleared ${flags.scope ?? "all"} data.`));
    }
    default:
      throw new UsageError("Usage: artifacts data ls | get <key> | export | clear [--scope shared|me]");
  }
}
