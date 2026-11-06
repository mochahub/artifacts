import { type Child, type Job, type Ran, startChild } from "@artifacts/sandbox";
import { ApiError } from "../http/errors.ts";
import type { Logger } from "../log.ts";

export const WAIT_PER_BACKEND = 4;
export const WAIT_PER_CHILD = 32;
const noop = () => {};

/** Which child a backend runs on: fixed by its hash, so its instance stays warm. */
export const childIndex = (hash: string, size: number) => Number.parseInt(hash.slice(0, 8), 16) % size;

/**
 * Starts and supervises the sandbox processes (08). Each backend is pinned to one child by its hash, and
 * its requests run one at a time. An instance belongs to one artifact and hash, so two artifacts with the
 * same code share nothing. The app holds the scope of every request; the child never sees it.
 */
export class SandboxPool {
  private children: (Child | null)[];
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly waiting = new Map<string, number>();
  private readonly perChild = new Map<number, number>();
  private nextId = 0;
  private stopped = false;

  constructor(
    private readonly size: number,
    private readonly log: Logger,
  ) {
    this.children = new Array(size).fill(null);
  }

  private async child(index: number): Promise<Child> {
    const current = this.children[index];
    if (current?.alive()) return current;
    const started = startChild({
      onExit: () => {
        if (!this.stopped) this.log.warn("a sandbox process exited; starting another on the next request");
        this.children[index] = null;
      },
    });
    this.children[index] = started;
    await started.up;
    return started;
  }

  private indexFor(hash: string) {
    return childIndex(hash, this.size);
  }

  /** Runs one of an artifact's requests. A child that dies on it answers with `crashed`. */
  async run(artifactId: string, job: Job): Promise<Ran> {
    const key = `${artifactId}:${job.hash}`;
    const index = this.indexFor(job.hash);
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
        backstop = setTimeout(() => child.kill(), job.limits.timeoutMs + 2000);
      };
      try {
        return await child.run({ ...job, hash: key, id, onStart: start });
      } finally {
        clearTimeout(backstop);
      }
    });
    // The queue holds only that it's over, never the result, which may be megabytes.
    const tail = work.then(noop, noop);
    this.queues.set(key, tail);
    try {
      return await work;
    } finally {
      const left = (this.waiting.get(key) ?? 1) - 1;
      if (left > 0) this.waiting.set(key, left);
      else this.waiting.delete(key);
      if (this.queues.get(key) === tail) this.queues.delete(key);
      this.perChild.set(index, (this.perChild.get(index) ?? 1) - 1);
    }
  }

  /**
   * For a test: a backend can't make its own child die, by design, so this is the only way to check that a
   * child's death answers 502 and the next request gets a new one.
   */
  async killChild() {
    (await this.child(0)).kill();
  }

  stop() {
    this.stopped = true;
    for (const child of this.children) child?.kill();
  }
}
