import type { Renders } from "@artifacts/schema";
import type { Deps } from "../deps.ts";
import { blobKey } from "../layout.ts";
import { keyOf } from "./diff.ts";
import { diffRegions, type Region } from "./regions.ts";

const MAX_CACHED_REGIONS = 2000;
const MAX_FRAMES_DIFFED = 40;
const COMPARES_PER_MINUTE = 30;

type Frame = { pageKey: string; frameKey: string; renders: Renders };
export type ChangedRegions = Record<string, { before: string; after: string; regions: Region[] }>;

/**
 * Where changed frames differ, for compare (03). One render pair never changes its answer, so it's worked
 * out once per server, and each diff holds two renders in memory, so only one runs at a time.
 */
export function createComparer(deps: Pick<Deps, "bucket" | "limits">) {
  const cache = new Map<string, Region[]>();
  let diffing: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>) => {
    const run = diffing.then(work, work);
    diffing = run.catch(() => {});
    return run;
  };

  async function regionsOf(a: string, b: string) {
    const [first, second] = await Promise.all([deps.bucket.get(blobKey(a)), deps.bucket.get(blobKey(b))]);
    if (!first || !second) return undefined;
    // A render the image library can't read still counts as changed: it just has no boxes.
    return diffRegions(first.body, second.body).catch(() => [] as Region[]);
  }

  /** Per changed frame, the first 40: the two @2x renders, and where they differ. `who` pays for new diffs. */
  return async function changedRegions(keys: string[], before: Frame[], after: Frame[], who: string) {
    const rendersOf = (rows: Frame[], key: string) =>
      rows.find((row) => keyOf(row.pageKey, row.frameKey) === key)?.renders;
    const result: ChangedRegions = {};
    let counted = false;
    for (const key of keys.slice(0, MAX_FRAMES_DIFFED)) {
      const a = rendersOf(before, key)?.["2x"];
      const b = rendersOf(after, key)?.["2x"];
      if (!a || !b) continue;
      let regions = cache.get(`${a}:${b}`);
      if (!regions) {
        if (!counted) deps.limits.hit(`compare:${who}`, COMPARES_PER_MINUTE, 60_000);
        counted = true;
        regions = await oneAtATime(() => regionsOf(a, b));
        if (!regions) continue;
        if (cache.size >= MAX_CACHED_REGIONS) cache.clear();
        cache.set(`${a}:${b}`, regions);
      }
      result[key] = { before: a, after: b, regions };
    }
    return result;
  };
}
