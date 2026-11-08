import { Slug } from "@artifacts/schema";
import type { McpToolSpec } from "@artifacts/schema/mcp";
import { and, eq } from "drizzle-orm";
import type { Caller } from "../auth/caller.ts";
import { projects } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { loadSafeConfig } from "../librarian/index.ts";
import { EnqueueRequest, enqueueSource } from "../librarian/ingestion/index.ts";

const Request = EnqueueRequest.extend({ wiki: Slug }).strict();
export function sourceAddTool(deps: Deps) {
  return {
    name: "artifacts_source_add",
    description:
      "Queue an untrusted wiki source. Does not enable Librarian or complete processing. Files require an owned wiki-bound quarantine uploadId; never a filesystem path.",
    scope: "publish" as const,
    properties: {
      wiki: { type: "string", description: "Wiki slug" },
      source: {
        type: "object",
        description: "SourceInput: text (text,title), url (url,title?), or file (uploadId,title?) with kind",
      },
      idempotencyKey: { type: "string", description: "Stable UUID; reuse for retries with identical input" },
      note: { type: "string", description: "Optional plain text note, at most 2000 characters" },
    },
    required: ["wiki", "source", "idempotencyKey"],
    async run({ orgId, caller, input }: { orgId: string; caller: Caller; input: Record<string, unknown> }) {
      const parsed = Request.safeParse(input);
      if (!parsed.success) throw new ApiError("invalid", "Invalid source submission.");
      const { wiki, ...body } = parsed.data;
      const [project] = await deps.db
        .select()
        .from(projects)
        .where(and(eq(projects.orgId, orgId), eq(projects.slug, wiki)));
      if (!project) throw new ApiError("not_found", "Not found.");
      // enqueueSource is authoritative for can(project.publish), selected wiki, ownership and replay.
      const result = await enqueueSource(deps, { orgId, caller, wikiId: project.id }, body);
      const config = await loadSafeConfig(deps, orgId);
      return {
        ...result.item,
        requestId: body.idempotencyKey,
        message:
          deps.env.librarianAllowed && config.enabled
            ? "Saved to inbox."
            : "Saved to inbox. Librarian is off.",
      };
    },
  } satisfies McpToolSpec & { scope: "publish"; run: unknown };
}
