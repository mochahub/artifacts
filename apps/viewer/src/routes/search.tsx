import { SignedIn } from "../components/guard.tsx";
import { SearchBox } from "../components/search-box.tsx";
import { Shell } from "../components/shell.tsx";
import { useTitle } from "../title.ts";

export function SearchPage() {
  useTitle("Search");
  return (
    <SignedIn>
      <Shell>
        <h1 class="h1 l">Search</h1>
        <SearchBox />
      </Shell>
    </SignedIn>
  );
}
