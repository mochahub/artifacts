// The types for host.js: the backend contract (08) as the app, `artifacts dev` and `artifacts render` use it.

export type SandboxRequest = { url: string; method: string; headers: Record<string, string>; body: string };
export type SandboxResponse = { status: number; headers: [string, string][]; body: string };
export type Log = { level: string; message: string };

/** What the child enforces on one request. */
export type ChildLimits = {
  timeoutMs: number;
  memoryMb: number;
  dataOpBytes: number;
  logLines: number;
  logBytes: number;
};

/** One `env.DATA` call (08). `ifMatch: "*"` means only if the key is new. */
export type DataOp = {
  op: "get" | "put" | "delete" | "list";
  key?: string;
  prefix?: string;
  cursor?: string;
  value?: unknown;
  ifMatch?: string;
};
export type DataAnswer = { value: unknown } | { error: { code: string; message: string } };
export type DataHandler = (op: DataOp) => Promise<DataAnswer>;

export type Job = {
  hash: string;
  code: () => string;
  limits: ChildLimits;
  request: SandboxRequest;
  onData(raw: string): Promise<DataAnswer>;
};
export type Ran = { response?: SandboxResponse; logs: Log[]; crashed?: boolean };

export type Child = {
  up: Promise<void>;
  pid: number;
  kill(): void;
  alive(): boolean;
  run(job: Job & { id: number; onStart?: () => void }): Promise<Ran>;
  env(): Promise<string[]>;
};
export function startChild(options?: { onExit?: () => void }): Child;
export function localSandbox(): { run(job: Job): Promise<Ran>; kill(): void };

/** The org's limits that a backend request runs under (08). */
export type BackendLimits = {
  backendTimeoutMs: number;
  backendMemoryMb: number;
  dataValueBytes: number;
  backendResponseBytes: number;
};
/** Who is asking, as the backend reads it from X-Caller with `caller()` from @artifacts/kit/backend (08). */
export type Caller = { id: string; name: string; kind: string; canComment: boolean; isPublisher: boolean };

export function runBackend(options: {
  run(job: Job): Promise<Ran>;
  hash: string;
  code: () => string;
  limits: BackendLimits;
  caller: Caller;
  /** `path` is what follows `api/`, and `search` the query string with its `?`, or "". */
  request: { method: string; path: string; search: string; contentType: string | null; body: string };
  onData: DataHandler;
}): Promise<{ response: Response; logs: Log[] }>;

export const CORS: Record<string, string>;
export const SAFE_HEADERS: Set<string>;
export function preflight(): Response;
export function scopedKey(key: string): string;

/** Stored keys such as `shared/votes`, with an etag each, or null for a key that isn't there. */
export type LocalStore = {
  valid?(key: string): boolean;
  keys(): string[];
  get(key: string): { value: unknown; etag: string } | undefined;
  etag(key: string): string | null;
  put(key: string, value: unknown): string;
  delete(key: string): void;
};
export function localData(store: LocalStore): DataHandler;
