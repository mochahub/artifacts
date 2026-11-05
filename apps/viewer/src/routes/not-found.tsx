import { useTitle } from "../title.ts";

export function NotFound() {
  useTitle("Nothing here");
  return (
    <main class="screen">
      <h1 class="h1">Nothing here</h1>
      <p class="sub">
        This page doesn't exist. <a href="/">Go to Artifacts</a>
      </p>
    </main>
  );
}
