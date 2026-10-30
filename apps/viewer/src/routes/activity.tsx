import { Shell } from "../components/shell.tsx";
import { SignedIn } from "./guard.tsx";

/** Filled in with the activity feed in M7. */
export const Activity = () => (
  <SignedIn>
    <Shell>
      <h1 class="h1 l">Activity</h1>
    </Shell>
  </SignedIn>
);
