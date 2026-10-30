/** A deleted link: the date only, no title and no names (07·6). */
export function Deleted({ at }: { at: string }) {
  return (
    <main class="screen">
      <h1 class="h1 m">This artifact was deleted</h1>
      <p class="sub">
        On {new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}.
      </p>
    </main>
  );
}
