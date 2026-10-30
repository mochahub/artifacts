import { z } from "zod";
import { Key, Slug, Visibility } from "./manifest.ts";

/** Request and response shapes for the HTTP API. 03-api.md owns the names; 02 owns the enums. */

const Id = z.uuid();
const Time = z.iso.datetime({ offset: true });
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Email = z.string().email();
const Password = z.string().min(12).max(256);

// Enums (02)
export const Role = z.enum(["owner", "admin", "member", "reviewer", "outside"]);
export type Role = z.infer<typeof Role>;
export const Permission = z.enum(["view", "comment", "publish"]);
export type Permission = z.infer<typeof Permission>;
export const PageKind = z.enum(["canvas", "article", "prototype", "gallery", "deck"]);
export const ThreadStatus = z.enum(["open", "fixed", "resolved"]);
export const AnchorState = z.enum(["ok", "updated", "orphaned", "moved_version"]);
export const DecisionKind = z.enum(["approved", "changes_requested"]);
export const DataScope = z.enum(["shared", "me"]);

// Errors
export const ERROR_STATUS = {
  invalid: 400,
  unauthenticated: 401,
  recent_auth_required: 401,
  forbidden: 403,
  csrf: 403,
  read_only: 403,
  not_found: 404,
  conflict: 409,
  slug_deleted: 409,
  gone: 410,
  precondition_failed: 412,
  too_large: 413,
  misdirected: 421,
  cli_outdated: 426,
  rate_limited: 429,
  setup_mode: 503,
  busy: 503,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;

export const ApiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

// Setup and meta
export const Health = z.object({ ok: z.literal(true), version: z.string(), setupMode: z.boolean() });
export type Health = z.infer<typeof Health>;

export const Meta = z.object({
  version: z.string(),
  minCliVersion: z.string(),
  orgName: z.string().nullable(),
  homeDomain: z.string().nullable(),
  publicUrl: z.string(),
  contentUrl: z.string().nullable(),
  viewerOrigins: z.array(z.string()),
});
export type Meta = z.infer<typeof Meta>;

export const Person = z.object({ id: Id, name: z.string(), email: z.string(), role: Role });
export type Person = z.infer<typeof Person>;

export const SetupRequest = z.object({
  setupToken: z.string(),
  orgName: z.string().min(1),
  name: z.string().min(1),
  email: Email,
  password: Password,
  clientName: z.string().min(1),
  agent: z.string().optional(),
});
export const SetupResponse = z.object({ person: Person, token: z.string() });
export const RecoverRequest = z.object({ setupToken: z.string(), email: Email });
export const RecoverResponse = z.object({ resetUrl: z.string() });

// Sign-in and account
export const PasswordSignIn = z.object({ email: Email, password: z.string() });
export const PersonResponse = z.object({ person: Person });
export const PasskeyOptions = z.object({ local: z.boolean().optional() });
export const PasskeyVerify = z.object({ challengeId: Id, response: z.unknown() });
export const Me = z.object({ person: Person, org: z.object({ name: z.string() }), recentAuth: z.boolean() });
export const SessionRow = z.object({
  id: Id,
  kind: z.enum(["session", "cli"]),
  name: z.string(),
  userAgent: z.string().nullable(),
  lastSeenAt: Time.nullable(),
  current: z.boolean(),
});
export const ChangePassword = z.object({ password: Password });
export const AddPasskeyVerify = PasskeyVerify.extend({ name: z.string().optional() });
export const RenamePasskey = z.object({ name: z.string().min(1) });
export const Reauth = z.union([z.object({ password: z.string() }), PasskeyVerify]);

// Invites, resets and joining
export const InvitePreview = z.object({
  orgName: z.string(),
  invitedBy: z.string(),
  role: Role,
  email: z.string(),
  artifact: z.object({ title: z.string() }).optional(),
});
export const AcceptInvite = z.object({ name: z.string().min(1), password: Password.optional() });
export const ResetPreview = z.object({ email: z.string() });
export const ResetPassword = ChangePassword;

// Device flow
export const DeviceStart = z.object({ clientName: z.string().min(1), agent: z.string().optional() });
export const DeviceStarted = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUrl: z.string(),
  interval: z.number().int(),
  expiresIn: z.number().int(),
});
export const DevicePoll = z.object({ deviceCode: z.string() });
export const DevicePollResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("approved"), token: z.string(), person: Person }),
]);
export const DeviceDetails = z.object({
  clientName: z.string(),
  agent: z.string().nullable(),
  createdAt: Time,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});

// Guests
export const GuestName = z.object({ name: z.string().min(1).max(60) });

// Organization and people
export const INVITE_ROLES = ["admin", "member", "reviewer"] as const;
export const CreateInvite = z.object({ email: Email, role: z.enum(INVITE_ROLES) });
export const InviteCreated = z.object({ invite: z.object({ id: Id }).loose(), url: z.string() });
export const ChangeRole = z.object({ role: Role });
export const CreateOrgToken = z.object({
  name: z.string().min(1),
  scopes: z.array(z.enum(["publish", "comment", "read", "manage", "data", "org"])),
  projectIds: z.array(Id).optional(),
  expiresAt: Time.optional(),
});

export const OrgLimits = z.object({
  dataValueBytes: z.number().int().positive(),
  dataKeysPerScope: z.number().int().positive(),
  dataBytesPerScope: z.number().int().positive(),
  fileBytes: z.number().int().positive(),
  filesBytesPerArtifact: z.number().int().positive(),
  backendCodeBytes: z.number().int().positive(),
  backendTimeoutMs: z.number().int().positive(),
  backendMemoryMb: z.number().int().positive(),
  backendRequestBytes: z.number().int().positive(),
  backendResponseBytes: z.number().int().positive(),
  backendRequestsPerMinute: z.number().int().positive(),
  writesPerSecond: z.number().int().positive(),
});

export const OrgSettings = z.object({
  defaultVisibility: Visibility,
  linkSharing: z.boolean(),
  limits: OrgLimits,
  sandboxProcesses: z.number().int().positive(),
});
export type OrgSettings = z.infer<typeof OrgSettings>;

const MB = 1024 * 1024;

/** Written to `org.settings` at setup (02). Limit defaults come from 08. */
export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  defaultVisibility: "org",
  linkSharing: true,
  limits: {
    dataValueBytes: 64 * 1024,
    dataKeysPerScope: 1000,
    dataBytesPerScope: 5 * MB,
    fileBytes: 10 * MB,
    filesBytesPerArtifact: 100 * MB,
    backendCodeBytes: MB,
    backendTimeoutMs: 10_000,
    backendMemoryMb: 64,
    backendRequestBytes: MB,
    backendResponseBytes: 5 * MB,
    backendRequestsPerMinute: 120,
    writesPerSecond: 10,
  },
  sandboxProcesses: 2,
};

export const PatchOrg = z.object({
  name: z.string().min(1).optional(),
  settings: OrgSettings.partial().optional(),
});

// Projects, artifacts and lists
export const ArtifactStatus = z.object({
  kind: z.enum(["waiting", "with_agent", "approved", "not_reviewed"]),
  agent: z.string().optional(),
  version: z.number().int().optional(),
});

export const ArtifactCard = z.object({
  id: Id,
  project: z.string(),
  slug: z.string(),
  title: z.string(),
  cover: z.union([z.object({ renderHash: Sha256 }), z.object({ title: z.string() })]),
  pageCount: z.number().int(),
  latestVersion: z.number().int(),
  status: ArtifactStatus,
  counts: z.object({
    open: z.number().int(),
    repliesToYou: z.number().int(),
    changedFrames: z.number().int(),
  }),
  publishedBy: z.string(),
  agent: z.string().nullable(),
  publishedAt: Time,
  archivedAt: Time.nullable(),
});
export type ArtifactCard = z.infer<typeof ArtifactCard>;

export const Decision = z.object({
  kind: DecisionKind,
  note: z.string().nullable(),
  version: z.number().int(),
  by: z.string(),
  at: Time,
});

export const Artifact = ArtifactCard.extend({
  visibility: Visibility,
  publisherId: Id,
  hasBackend: z.boolean(),
  pages: z.array(
    z.object({
      key: z.string(),
      kind: PageKind,
      title: z.string().nullable(),
      group: z.string().nullable(),
      changed: z.boolean(),
      open: z.number().int(),
    }),
  ),
  decision: Decision.nullable(),
  permissions: z.object({
    comment: z.boolean(),
    manage: z.boolean(),
    share: z.boolean(),
    delete: z.boolean(),
    purge: z.boolean(),
  }),
});
export type Artifact = z.infer<typeof Artifact>;

export const Home = z.object({ waiting: z.array(ArtifactCard), recent: z.array(ArtifactCard) });
export const ProjectRow = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  repo: z.string().nullable(),
  artifactCount: z.number().int(),
  openCount: z.number().int(),
  updatedAt: Time,
});
export const ProjectArtifacts = z.object({
  project: z.object({ slug: z.string(), name: z.string(), repo: z.string().nullable() }),
  artifacts: z.array(ArtifactCard),
});
export type ProjectArtifacts = z.infer<typeof ProjectArtifacts>;
export type ProjectRow = z.infer<typeof ProjectRow>;
export type Home = z.infer<typeof Home>;
export const PatchArtifact = z.object({ visibility: Visibility.optional() });

// Sharing
export const AddAccess = z.object({ email: Email, permission: Permission });
export const CreateShareLink = z.object({
  permission: Permission.exclude(["publish"]),
  expiresIn: z.enum(["1d", "7d", "30d"]).nullable().optional(),
});

// Versions
export const VersionRow = z.object({
  n: z.number().int(),
  name: z.string().nullable(),
  message: z.string().nullable(),
  publishedBy: z.string(),
  agent: z.string().nullable(),
  publishedAt: Time,
  restoredFrom: z.number().int().nullable(),
  decision: DecisionKind.optional(),
  changes: z.object({ frames: z.number().int(), blocks: z.number().int() }),
});
export type VersionRow = z.infer<typeof VersionRow>;
export const NameVersion = z.object({ name: z.string().nullable() });

export const CanvasFrame = z.object({
  key: z.string(),
  board: z.string(),
  title: z.string().nullable(),
  device: z.string().nullable(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  contentHash: z.string(),
  renders: z.object({ "1x": z.string(), "2x": z.string(), "3x": z.string(), thumb: z.string() }),
  live: z.boolean(),
  livePath: z.string().nullable().optional(),
  changed: z.boolean(),
});
export type CanvasFrame = z.infer<typeof CanvasFrame>;

// Publishing
const FileRef = z.object({ hash: Sha256, size: z.number().int().nonnegative(), type: z.string() });

export const PublishPrepare = z.object({
  project: Slug,
  projectName: z.string().optional(),
  repo: z.string().nullable().optional(),
  slug: Slug,
  title: z.string().min(1).max(120),
  visibility: Visibility.optional(),
  files: z
    .array(
      z.object({ path: z.string(), sha256: Sha256, size: z.number().int().nonnegative(), type: z.string() }),
    )
    .max(20_000),
});
export const PublishPrepared = z.object({
  uploadId: z.string(),
  artifactId: Id,
  missing: z.array(z.object({ sha256: Sha256, url: z.string(), headers: z.record(z.string(), z.string()) })),
});
export type PublishPrepared = z.infer<typeof PublishPrepared>;

export const BoardRecord = z.object({
  key: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export const OutlineEntry = z.object({ id: z.string(), title: z.string(), level: z.number().int() });
export const PageRecord = z.object({
  key: Key,
  kind: PageKind,
  title: z.string().nullable(),
  group: z.string().nullable(),
  position: z.number().int(),
  meta: z.object({
    readingMinutes: z.number().optional(),
    htmlHash: Sha256.optional(),
    outline: z.array(OutlineEntry).optional(),
    boards: z.array(BoardRecord).optional(),
    device: z.string().optional(),
    livePath: z.string().optional(),
    items: z.array(z.object({ hash: Sha256, caption: z.string().optional() })).optional(),
  }),
});
export type PageRecord = z.infer<typeof PageRecord>;
export const FrameRecord = z.object({
  pageKey: z.string(),
  boardKey: z.string(),
  frameKey: z.string(),
  title: z.string().nullable(),
  device: z.string().nullable(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  contentHash: Sha256,
  renders: z.object({ "1x": Sha256, "2x": Sha256, "3x": Sha256, thumb: Sha256 }),
  livePath: z.string().nullable(),
});
export type FrameRecord = z.infer<typeof FrameRecord>;
export const BlockRecord = z.object({
  pageKey: z.string(),
  blockKey: z.string(),
  contentHash: Sha256,
  text: z.string(),
});
export type BlockRecord = z.infer<typeof BlockRecord>;

export const PublishCommit = z.object({
  uploadId: z.string(),
  message: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  notes: z.record(z.string(), z.string()).default({}),
  agent: z.string().nullable().optional(),
  files: z.record(z.string(), FileRef),
  backendHash: Sha256.nullable().optional(),
  pages: z.array(PageRecord),
  frames: z.array(FrameRecord),
  blocks: z.array(BlockRecord),
});
const ChangeSet = z.object({
  added: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional(),
  changed: z.array(z.string()).optional(),
});
export const PublishResult = z.object({
  version: z.number().int(),
  url: z.string(),
  changes: z.object({ frames: ChangeSet, blocks: ChangeSet }),
  threadsOnChanged: z.array(z.number().int()),
  orphaned: z.array(z.number().int()),
  uploaded: z.object({ files: z.number().int(), bytes: z.number().int() }),
  reused: z.number().int(),
});
export type PublishResult = z.infer<typeof PublishResult>;

// Review
export const Anchor = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("frame"),
    frameKey: z.string(),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal("text"),
    blockKey: z.string(),
    quote: z.object({ exact: z.string(), prefix: z.string(), suffix: z.string() }),
  }),
  z.object({ type: z.literal("block"), blockKey: z.string() }),
]);
export type Anchor = z.infer<typeof Anchor>;

const Body = z.string().min(1).max(10_000);
const CommentAuthor = z.object({ name: z.string(), kind: z.enum(["person", "guest", "agent"]) });

export const Comment = z.object({
  id: Id,
  author: CommentAuthor,
  agent: z.string().nullable(),
  body: z.string(),
  version: z.number().int(),
  marksFixed: z.boolean(),
  createdAt: Time,
  editedAt: Time.nullable().optional(),
});
export type Comment = z.infer<typeof Comment>;
export const Thread = z.object({
  id: Id,
  n: z.number().int(),
  pageKey: z.string(),
  anchor: Anchor.nullable(),
  anchorState: AnchorState,
  status: ThreadStatus,
  createdVersion: z.number().int(),
  fixedVersion: z.number().int().nullable(),
  author: CommentAuthor,
  crop: z.string().nullable(),
  comments: z.array(Comment),
  createdAt: Time,
  resolvedAt: Time.nullable(),
});
export type Thread = z.infer<typeof Thread>;

export const CreateThread = z.object({
  pageKey: z.string(),
  anchor: Anchor.nullable(),
  body: Body,
  version: z.number().int(),
  agent: z.string().max(60).nullable().optional(),
});
export const CreateComment = z.object({
  body: Body,
  marksFixed: z.boolean().optional(),
  agent: z.string().max(60).nullable().optional(),
});
export const EditComment = z.object({ body: Body });
export const CreateDecision = z.object({
  version: z.number().int(),
  kind: DecisionKind,
  note: z.string().nullable().optional(),
});
export const ArtifactReviewStatus = z.object({
  version: z.number().int(),
  decision: DecisionKind.nullable(),
  decisionVersion: z.number().int().nullable(),
  note: z.string().nullable(),
  open: z.array(Thread),
  fixedAwaiting: z.array(Thread),
});
export type ArtifactReviewStatus = z.infer<typeof ArtifactReviewStatus>;
export const Seen = z.object({
  version: z.number().int(),
  pageKey: z.string().optional(),
  position: z.unknown().optional(),
});

// Data store
export const DataPut = z.object({ value: z.json() });
export const DataList = z.object({
  keys: z.array(z.object({ key: z.string(), etag: z.string(), size: z.number().int(), updatedAt: Time })),
  nextCursor: z.string().nullable(),
});
export const DataValue = z.object({ value: z.json(), etag: z.string() });
export const DataClear = z.object({ scope: DataScope.optional() });

// Content host
export const ContentTokenRequest = z.object({ version: z.number().int() });
export const ContentToken = z.object({ base: z.string(), expiresAt: Time });
