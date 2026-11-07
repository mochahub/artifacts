import { z } from "zod";
import { WikiAudience } from "./api.ts";
import {
  AGENT_MAX,
  ATOM_KINDS,
  BLOCK_ID_PATTERN,
  CHECKPOINT_KINDS,
  EDIT_MODES,
  EDIT_OP_MARKDOWN_MAX,
  EDIT_OPS_MAX,
  NOT_EDITABLE_REASONS,
  RUN_GOAL_MAX,
  RUN_STATUSES,
  SLUG_PATTERN,
  SUGGESTION_NOTE_MAX,
  SUGGESTION_OPS,
  SUGGESTION_STATUSES,
  VERSION_NAME_MAX,
  WIKI_SOURCES_MAX,
} from "./constants.ts";
import { Summary, Tags } from "./manifest.ts";

/**
 * Editing wiki pages in the browser and by agent operations (SPEC 16, Part B). 13-editing.md owns these
 * names and shapes; the HTTP routes, the MCP tools and the sync control messages all use them.
 */

const Id = z.uuid();
const Time = z.iso.datetime({ offset: true });

export const BlockId = z.string().regex(BLOCK_ID_PATTERN, "a block id, like ~k3j9x0a1b2");
export type BlockId = z.infer<typeof BlockId>;
/** The first 12 hex characters of a block's content hash: what an agent read, so a stale edit is caught. */
export const BlockBase = z.string().regex(/^[0-9a-f]{12}$/, "the 12-character hash page_read gave");
export const EditMode = z.enum(EDIT_MODES);
export const CheckpointKind = z.enum(CHECKPOINT_KINDS);
export const SuggestionStatus = z.enum(SUGGESTION_STATUSES);
export type SuggestionStatus = z.infer<typeof SuggestionStatus>;
export const SuggestionOp = z.enum(SUGGESTION_OPS);
export const RunStatus = z.enum(RUN_STATUSES);
export const AtomKind = z.enum(ATOM_KINDS);
export const NotEditableReason = z.enum(NOT_EDITABLE_REASONS);
const SourceSlugs = z.array(z.string().regex(SLUG_PATTERN)).max(WIKI_SOURCES_MAX);
const OpMarkdown = z.string().max(EDIT_OP_MARKDOWN_MAX);

/** How an agent's edit lands on this page now: applied, as a suggestion, or not at all (13, "Policy"). */
export const AgentPolicy = z.object({
  edits: z.enum(["direct", "suggestion", "refused"]),
  /** Why: the audience, an agent-maintained page, a Delegate run, someone in Pair or in Write. */
  reason: z.enum(["only_reader", "maintained", "run", "audience", "pair", "writing", "no_edit", "person"]),
  text: z.string(),
});
export type AgentPolicy = z.infer<typeof AgentPolicy>;

/** Someone in the editor, or an agent at work. Only callers who can edit see these. */
export const Presence = z.object({
  kind: z.enum(["person", "agent"]),
  name: z.string(),
  /** An agent's person: who it acts for. Null for a person, and for an organization token. */
  for: z.string().nullable(),
  mode: EditMode.nullable(),
  block: BlockId.nullable(),
  run: Id.nullable(),
});
export type Presence = z.infer<typeof Presence>;

/** `GET /api/artifacts/:id/doc`. Everything past `canEdit` is null or empty for someone who can't edit. */
export const DocState = z.object({
  editable: z.boolean(),
  reason: NotEditableReason.nullable(),
  canEdit: z.boolean(),
  canAccept: z.boolean(),
  canMaintain: z.boolean(),
  /** The latest version (checkpoint): what readers see. */
  version: z.number().int(),
  /** Whether the draft has changes since that version. */
  dirty: z.boolean(),
  seq: z.number().int(),
  epoch: z.number().int(),
  updatedAt: Time.nullable(),
  agentMaintained: z.boolean(),
  audience: WikiAudience.nullable(),
  agents: AgentPolicy.nullable(),
  present: z.array(Presence),
  openSuggestions: z.number().int(),
  runs: z.array(z.lazy(() => Run)),
});
export type DocState = z.infer<typeof DocState>;

/** `GET /api/artifacts/:id/doc/draft`: the draft drawn by the server, for the reading view. */
export const DraftView = z.object({
  html: z.string(),
  blockIds: z.array(BlockId),
  outline: z.array(z.object({ id: z.string(), title: z.string(), level: z.number().int() })),
  version: z.number().int(),
  seq: z.number().int(),
  updatedAt: Time.nullable(),
});
export type DraftView = z.infer<typeof DraftView>;

/** One top-level block as an agent reads it. */
export const PageBlock = z.object({
  id: BlockId,
  type: z.enum([
    "paragraph",
    "heading",
    "list",
    "table",
    "code",
    "quote",
    "callout",
    "component",
    "rule",
    "atom",
  ]),
  /** Pass this back as `base` to replace or delete the block. */
  base: BlockBase,
  markdown: z.string(),
  /** An image, diagram, chart or embed: it can be moved or deleted, not rewritten (13, "Atoms"). */
  atom: AtomKind.nullable(),
  /** Who wrote it: author keys from `PageRead.authors`. */
  authors: z.array(z.string()),
  /** Open threads anchored here, by number. */
  threads: z.array(z.number().int()),
});
export type PageBlock = z.infer<typeof PageBlock>;

export const Author = z.object({
  key: z.string(),
  kind: z.enum(["person", "agent"]),
  name: z.string(),
  /** The agent's name, such as "Claude Code". */
  agent: z.string().nullable(),
  /** For an agent, the person it acted for; null for an organization token. */
  for: z.string().nullable(),
  /** Source slugs the passage was written from, in the same wiki. A hidden one is left out. */
  sources: z.array(z.string()),
});
export type Author = z.infer<typeof Author>;

/** `artifacts_page_read`, and `GET /api/artifacts/:id/doc/markdown`. */
export const PageRead = z.object({
  artifact: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  tags: z.array(z.string()),
  sources: z.array(z.string()),
  /** The latest version. With `draft: true`, the blocks are the live draft after it. */
  version: z.number().int(),
  draft: z.boolean(),
  seq: z.number().int(),
  agents: AgentPolicy,
  blocks: z.array(PageBlock),
  authors: z.array(Author),
  /** Open suggestions on the page, so an agent doesn't repeat one. */
  suggestions: z.array(z.lazy(() => Suggestion)),
  nextCursor: z.string().nullable(),
});
export type PageRead = z.infer<typeof PageRead>;

/** One operation on a page. Markdown here is text only: no images, Mermaid, charts or embeds (13). */
export const EditOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace"), block: BlockId, base: BlockBase, markdown: OpMarkdown }),
  /** `after: null` puts it first. `after` may name a block this run inserted and hasn't had accepted. */
  z.object({ op: z.literal("insert"), after: BlockId.nullable(), markdown: OpMarkdown }),
  z.object({ op: z.literal("delete"), block: BlockId, base: BlockBase }),
  z.object({
    op: z.literal("meta"),
    title: z.string().trim().min(1).max(120).optional(),
    summary: Summary.optional(),
    tags: Tags.optional(),
    sources: SourceSlugs.optional(),
  }),
]);
export type EditOp = z.infer<typeof EditOp>;

/** `POST /api/artifacts/:id/doc/ops`, `artifacts_page_edit` and `artifacts_page_suggest`. */
export const EditRequest = z.object({
  ops: z.array(EditOp).min(1).max(EDIT_OPS_MAX),
  /** Ask for suggestions even where the edit could apply. `artifacts_page_suggest` always sets it. */
  suggest: z.boolean().optional(),
  /** Sources these ops were written from: the passages carry them. */
  sources: SourceSlugs.optional(),
  /** Why, in a sentence. Shown on suggestions and in the log. */
  note: z.string().trim().max(SUGGESTION_NOTE_MAX).optional(),
  /** Threads this addresses: marked fixed at the checkpoint that carries the change. */
  fixes: z.array(z.number().int().positive()).max(50).optional(),
  run: Id.optional(),
  /** Make a checkpoint right after, when every op applied. */
  checkpoint: z.boolean().optional(),
  agent: z.string().max(AGENT_MAX).nullable().optional(),
});
export type EditRequest = z.infer<typeof EditRequest>;

export const EditResult = z.object({
  results: z.array(
    z.object({
      index: z.number().int(),
      outcome: z.enum(["applied", "suggested", "refused"]),
      /** The block it touched or made. */
      block: BlockId.nullable(),
      suggestion: Id.nullable(),
      /** `held`: someone is in that block, so it became a suggestion. Refusals say why. */
      reason: z
        .enum(["held", "pair", "audience", "stale", "atom", "missing", "writing", "invalid", "limit"])
        .nullable(),
      message: z.string().nullable(),
    }),
  ),
  seq: z.number().int(),
  /** Set when `checkpoint` made one. */
  version: z.number().int().nullable(),
  agents: AgentPolicy,
});
export type EditResult = z.infer<typeof EditResult>;

export const Suggestion = z.object({
  id: Id,
  op: SuggestionOp,
  /** replace and delete: the block. insert: the block it goes after (null: first). */
  block: BlockId.nullable(),
  /** insert: the id the new block gets when accepted. */
  newBlock: BlockId.nullable(),
  base: BlockBase.nullable(),
  markdown: z.string().nullable(),
  /** meta: the fields it would set. */
  meta: z
    .object({
      title: z.string().optional(),
      summary: z.string().optional(),
      tags: z.array(z.string()).optional(),
      sources: z.array(z.string()).optional(),
    })
    .nullable(),
  /** The server's own rendering of the proposed block, sanitized, for the editor's preview. */
  html: z.string().nullable(),
  note: z.string().nullable(),
  sources: z.array(z.string()),
  fixes: z.array(z.number().int()),
  status: SuggestionStatus,
  run: Id.nullable(),
  author: Author,
  createdAt: Time,
  expiresAt: Time,
  decidedAt: Time.nullable(),
  decidedBy: z.string().nullable(),
});
export type Suggestion = z.infer<typeof Suggestion>;
export const SuggestionList = z.object({
  suggestions: z.array(Suggestion),
  nextCursor: z.string().nullable(),
});
export const AcceptSuggestion = z.object({
  /** Accept a stale replace anyway: the block becomes the suggestion's text. */
  force: z.boolean().optional(),
});
export const RejectSuggestion = z.object({ note: z.string().trim().max(SUGGESTION_NOTE_MAX).optional() });
export const SuggestionDecided = z.object({ status: SuggestionStatus, seq: z.number().int() });

export const Run = z.object({
  id: Id,
  status: RunStatus,
  /** suggestion: the run's edits wait as one change set for a person to accept (13, "Delegate"). */
  edits: z.enum(["direct", "suggestion"]),
  goal: z.string(),
  agent: z.string().nullable(),
  startedBy: z.string(),
  startedAt: Time,
  expiresAt: Time,
  finishedAt: Time.nullable(),
  /** The checkpoint it ended in, once there is one. */
  version: z.number().int().nullable(),
  suggestions: z.number().int(),
});
export type Run = z.infer<typeof Run>;
export const StartRun = z.object({
  goal: z.string().trim().min(1).max(RUN_GOAL_MAX),
  agent: z.string().max(AGENT_MAX).nullable().optional(),
});
export const FinishRun = z.object({ message: z.string().trim().max(2000).optional() });

export const Checkpoint = z.object({
  name: z.string().max(VERSION_NAME_MAX).nullable().optional(),
  message: z.string().trim().max(2000).nullable().optional(),
});
export const CheckpointResult = z.object({
  version: z.number().int(),
  /** False when there was nothing new: `version` is the latest. */
  created: z.boolean(),
  kind: CheckpointKind.nullable(),
});
export type CheckpointResult = z.infer<typeof CheckpointResult>;

export const SetMaintained = z.object({ agentMaintained: z.boolean() });

/** One passage: offsets into the block's normalized text (`blocks.text`), and its author's key. */
export const AuthorRun = z.object({ s: z.number().int(), e: z.number().int(), a: z.string(), t: Time });
export const Attribution = z.object({
  version: z.number().int().nullable(),
  draft: z.boolean(),
  authors: z.array(Author),
  blocks: z.record(z.string(), z.array(AuthorRun)),
});
export type Attribution = z.infer<typeof Attribution>;

/**
 * The control message (type 100 on the sync socket, after the y-protocols messages). The server sends
 * every kind but `mode`, which the client sends. JSON, UTF-8.
 */
export const SyncControl = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    /** This connection's author key: what its typing is marked with. */
    author: z.string(),
    epoch: z.number().int(),
    seq: z.number().int(),
    version: z.number().int(),
    canAccept: z.boolean(),
  }),
  z.object({ t: z.literal("mode"), mode: EditMode }),
  z.object({ t: z.literal("checkpoint"), version: z.number().int(), kind: CheckpointKind }),
  z.object({ t: z.literal("suggestion"), id: Id, status: SuggestionStatus }),
  z.object({ t: z.literal("run"), id: Id, status: RunStatus }),
  /** The draft was started again from a new version: offline changes can't merge into it. */
  z.object({ t: z.literal("reset"), epoch: z.number().int(), version: z.number().int() }),
  z.object({
    t: z.literal("error"),
    code: z.enum(["checkpoint_failed", "invalid_update", "too_large", "rate_limited"]),
    message: z.string(),
  }),
]);
export type SyncControl = z.infer<typeof SyncControl>;
/** The message types on the sync socket: y-protocols' sync and awareness, and ours. */
export const SYNC_MESSAGE = { sync: 0, awareness: 1, auth: 2, queryAwareness: 3, control: 100 } as const;
/** Close codes. Not found and not editable look the same, so a socket reveals nothing. */
export const SYNC_CLOSE = {
  invalidUpdate: 4400,
  unauthenticated: 4401,
  lostAccess: 4403,
  notFound: 4404,
  reset: 4409,
  tooLarge: 4413,
  rateLimited: 4429,
  restarting: 4000,
} as const;

/** What a client puts in its awareness state. The server replaces `user` with its own record of who it is. */
export const AwarenessState = z.object({
  user: z.object({
    author: z.string(),
    name: z.string(),
    kind: z.enum(["person", "agent"]),
    color: z.string(),
  }),
  mode: EditMode,
  /** The block with the caret, and blocks with changes not yet sent. Agents' replaces there become suggestions. */
  block: BlockId.nullable(),
  pending: z.array(BlockId).max(50),
  /** y-prosemirror's relative cursor positions. */
  cursor: z.unknown().optional(),
});
export type AwarenessState = z.infer<typeof AwarenessState>;
export type EditMode = z.infer<typeof EditMode>;
export type CheckpointKind = z.infer<typeof CheckpointKind>;
export type AtomKind = z.infer<typeof AtomKind>;
