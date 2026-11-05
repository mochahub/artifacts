import { useEffect } from "preact/hooks";
import { meta } from "./session.ts";

/** The tab's title: what this page is, then the org, so history and the tab strip read right. */
export function useTitle(...parts: (string | null | undefined)[]) {
  const title = parts.filter(Boolean).join(" – ");
  useEffect(() => {
    const org = meta.value?.orgName ?? "Artifacts";
    document.title = title ? `${title} – ${org}` : org;
  }, [title]);
}
