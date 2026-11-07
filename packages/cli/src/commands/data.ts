import {
  type BackendLog,
  type BackendLogs,
  type DataList,
  DataScope,
  type DataValue,
  isDataKey,
} from "@artifacts/schema";
import type { Input } from "../command.ts";
import { type Output, UsageError } from "../output.ts";
import { signedIn } from "../session.ts";
import { resolveArtifact, versionNumber } from "../target.ts";

/** `artifacts logs` (07): the last 24 hours, and then whatever arrives. */
export async function logsCommand(
  { flags }: Input<never, { follow?: boolean; version?: string; server?: string }>,
  out: Output,
) {
  if (flags.version) versionNumber(flags.version, "--version");
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, undefined);
  const query = flags.version ? `version=${flags.version}&` : "";
  let after = "";
  for (;;) {
    const lines = await client.get<BackendLogs>(`/api/artifacts/${artifact.id}/logs?${query}after=${after}`);
    if (!flags.follow) return out.result(lines, () => print(lines, out));
    print(lines, out);
    after = lines.at(-1)?.id ?? after;
    await Bun.sleep(2000);
  }
}

const print = (lines: BackendLog[], out: Output) => {
  for (const line of lines)
    out.say(`${line.createdAt.slice(11, 19)} v${line.version} ${line.level}  ${line.message}`);
};

export async function dataCommand(
  { args: { sub, key }, flags, usage }: Input<"sub" | "key", { scope?: string; server?: string }>,
  out: Output,
) {
  const scope = flags.scope ?? "shared";
  if (!DataScope.safeParse(scope).success) throw new UsageError("--scope is shared or me.");
  // A key with a ".." part would climb out of the data/ path in the URL.
  if (sub === "get" && key && !isDataKey(key)) throw new UsageError(`"${key}" isn't a valid data key.`);
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, undefined);
  const base = `/api/artifacts/${artifact.id}`;
  switch (sub) {
    case "ls": {
      const keys: DataList["keys"] = [];
      let cursor = "";
      do {
        const page = await client.get<DataList>(`${base}/data/${scope}?cursor=${encodeURIComponent(cursor)}`);
        keys.push(...page.keys);
        cursor = page.nextCursor ?? "";
      } while (cursor);
      return out.result(keys, () => {
        if (keys.length === 0) out.say("Nothing saved.");
        for (const entry of keys) out.say(`${entry.key}  ${entry.size} bytes`);
      });
    }
    case "get": {
      if (!key) throw usage(1);
      const { value } = await client.get<DataValue>(`${base}/data/${scope}/${key}`);
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
      throw usage();
  }
}
