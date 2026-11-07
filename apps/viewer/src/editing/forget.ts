/**
 * At sign-out: what editing kept on this device goes, so the next person on a shared device can't read
 * it. That is the unsent drafts in IndexedDB (cleared through the provider's own helpers, fetched only
 * now) and the author keys remembered per page.
 */
export async function forgetDrafts() {
  for (const key of Object.keys(localStorage))
    if (key.startsWith("artifacts.edit.")) localStorage.removeItem(key);
  if (typeof indexedDB === "undefined") return;
  const { indexedDbStore, forgetUnsent } = await import("./provider.ts");
  const keys = await indexedDbStore.keys("edit:");
  await Promise.all(
    keys.map((key) => {
      const [, artifactId = "", epoch = ""] = key.split(":");
      return forgetUnsent(artifactId, Number(epoch));
    }),
  );
}
