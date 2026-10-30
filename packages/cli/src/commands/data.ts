import { type Output, UsageError } from "../output.ts";
import { signedIn } from "./account.ts";
import { resolveArtifact } from "./review.ts";

type ListPage = { keys: { key: string; size: number; updatedAt: string }[]; nextCursor: string | null };

export async function dataCommand(
  sub: string | undefined,
  key: string | undefined,
  flags: { scope?: string; server?: string; target?: string },
  out: Output,
) {
  const scope = flags.scope ?? "shared";
  if (scope !== "shared" && scope !== "me") throw new UsageError("--scope is shared or me.");
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
