import { Artifact, Thread, type VersionDetail } from "@artifacts/schema";
import { z } from "zod";
import type { Client } from "../client.ts";
import type { Problem } from "./problem.ts";

/** `frames/renamed` (07): frames or blocks that were in the latest version and are gone. */
export async function renamedProblems(
  client: Client,
  project: string,
  slug: string,
  current: { frames: Set<string>; blocks: Set<string> },
): Promise<Problem[]> {
  let artifact: Artifact;
  try {
    artifact = Artifact.parse(await client.get(`/api/artifacts/by-slug/${project}/${slug}`));
  } catch {
    return []; // Nothing published yet, or not visible to this caller: prepare reports that.
  }
  const version = await client.get<VersionDetail>(
    `/api/artifacts/${artifact.id}/versions/${artifact.latestVersion}`,
  );
  const threads = z
    .array(Thread)
    .parse(await client.get(`/api/artifacts/${artifact.id}/threads?status=open`));
  const commented = new Set(
    threads.flatMap((thread) => {
      const anchor = thread.anchor;
      if (!anchor) return [];
      if ("object" in anchor) return [];
      return [anchor.type === "frame" ? anchor.frameKey : `${thread.pageKey}/${anchor.blockKey}`];
    }),
  );
  const problems: Problem[] = [];
  const check = (key: string, kind: string) => {
    const open = commented.has(key);
    problems.push({
      rule: "frames/renamed",
      severity: open ? "error" : "warning",
      message: `${kind} "${key}" was in v${artifact.latestVersion} and is gone${open ? ", and it has open comments. Put the id back" : ""}.`,
    });
  };
  for (const page of version.pages) {
    for (const frame of "frames" in page ? page.frames : []) {
      if (!current.frames.has(frame.key)) check(frame.key, "Frame");
    }
    for (const block of "blocks" in page ? page.blocks : []) {
      const key = `${page.key}/${block.key}`;
      if (!current.blocks.has(key) && commented.has(key)) check(key, "Block");
    }
  }
  return problems;
}
