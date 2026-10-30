import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error: plain JavaScript shared with the CLI
import { startChild } from "@artifacts/sandbox";
import type { Deps } from "../api/deps.ts";
import { ApiError } from "../http/errors.ts";

type Limits = { timeoutMs: number; memoryMb: number; dataOpBytes: number };
export type SandboxRequest = { url: string; method: string; headers: Record<string, string>; body: string };
export type SandboxResponse = { status: number; headers: [string, string][]; body: string };
type Log = { level: string; message: string };
type Child = ReturnType<typeof startChild>;

const WAIT_PER_BACKEND = 4;
const WAIT_PER_CHILD = 32;
const noop = () => {};

/** Beside server.js in the image, in packages/sandbox in the repo. */
function sandboxFiles() {
  const here = import.meta.dir;
  for (const dir of [here, join(here, "../../../../packages/sandbox/src")]) {
    const child = join(dir, existsSync(join(dir, "child.js")) ? "child.js" : "sandbox-child.js");
    const prelude = join(dir, existsSync(join(dir, "prelude.js")) ? "prelude.js" : "sandbox-prelude.js");
    if (existsSync(child) && existsSync(prelude)) return { child, prelude: readFileSync(prelude, "utf8") };
  }
  throw new Error("The sandbox files are missing.");
}

/**
 * Starts and supervises the sandbox processes (08). Each backend is pinned to one child by its hash, and
 * its requests run one at a time. An instance belongs to one artifact and hash, so two artifacts with the
 * same code share nothing. The app holds the scope of every request; the child never sees it.
 */
export class SandboxPool {
  private children: (Child | null)[];
  private readonly files = sandboxFiles();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly waiting = new Map<string, number>();
  private readonly perChild = new Map<number, number>();
  private nextId = 0;
  private stopped = false;

  constructor(
    private readonly size: number,
    private readonly log: Deps["log"],
  ) {
    this.children = new Array(size).fill(null);
  }

  private async child(index: number): Promise<Child> {
    const current = this.children[index];
    if (current?.alive()) return current;
    const started = startChild({
      childPath: this.files.child,
      prelude: this.files.prelude,
      onExit: () => {
        if (!this.stopped) this.log.warn("a sandbox process exited; starting another on the next request");
        this.children[index] = null;
      },
    }) as Child;
    this.children[index] = started;
    await started.up;
    return started;
  }

  private indexFor(hash: string) {
    return Number.parseInt(hash.slice(0, 8), 16) % this.size;
  }

  async run(options: {
    artifactId: string;
    hash: string;
    code: () => string;
    limits: Limits;
    request: SandboxRequest;
    onData(op: unknown): Promise<unknown>;
  }): Promise<{ response: SandboxResponse; logs: Log[] }> {
    const key = `${options.artifactId}:${options.hash}`;
    const index = this.indexFor(options.hash);
    const backendWaiting = this.waiting.get(key) ?? 0;
    const childWaiting = this.perChild.get(index) ?? 0;
    if (backendWaiting >= WAIT_PER_BACKEND || childWaiting >= WAIT_PER_CHILD) {
      throw new ApiError("busy", "This backend is busy. Try again.");
    }
    this.waiting.set(key, backendWaiting + 1);
    this.perChild.set(index, childWaiting + 1);

    // One at a time per backend. Queue time doesn't count against the deadline (08).
    const previous = this.queues.get(key) ?? Promise.resolve();
    const work = previous.then(async () => {
      const child = await this.child(index);
      const id = ++this.nextId;
      // The child enforces the deadline. This is the backstop if it can't, say a hang in the engine. It
      // starts when the child picks the request up: before that it may be waiting behind another
      // backend's loop, and killing the child for that would take every backend on it down.
      let backstop: ReturnType<typeof setTimeout> | undefined;
      const start = () => {
        clearTimeout(backstop);
        backstop = setTimeout(() => child.kill(), options.limits.timeoutMs + 2000);
      };
      try {
        return await child.run({ ...options, hash: key, id, onStart: start });
      } finally {
        clearTimeout(backstop);
      }
    });
    // The queue holds only that it's over, never the result, which may be megabytes.
    const tail = work.then(noop, noop);
    this.queues.set(key, tail);
    try {
      const result = (await work) as { response?: SandboxResponse; logs: Log[]; crashed?: boolean };
      if (result.crashed || !result.response) {
        return {
          response: { status: 502, headers: [], body: '{"error":"The sandbox stopped."}' },
          logs: result.logs,
        };
      }
      return { response: result.response, logs: result.logs };
    } finally {
      const left = (this.waiting.get(key) ?? 1) - 1;
      if (left > 0) this.waiting.set(key, left);
      else this.waiting.delete(key);
      if (this.queues.get(key) === tail) this.queues.delete(key);
      this.perChild.set(index, (this.perChild.get(index) ?? 1) - 1);
    }
  }

  /** Test hooks: what the first child's environment holds, and killing it. */
  async childEnv() {
    return (await this.child(0)).env() as Promise<string[]>;
  }
  async killChild() {
    (await this.child(0)).kill();
  }

  stop() {
    this.stopped = true;
    for (const child of this.children) child?.kill();
  }
}
