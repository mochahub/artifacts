import pkg from "../package.json";

export const VERSION = pkg.version;

/** Whether version `a` comes before `b`. Something that isn't a version, such as `dev`, never does. */
export function olderThan(a: string, b: string) {
  try {
    return Bun.semver.order(a, b) < 0;
  } catch {
    return false;
  }
}
