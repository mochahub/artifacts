import type { Home as HomeData } from "@artifacts/schema";
import { FileText } from "lucide-preact";
import { ReviewCard } from "../components/cards.tsx";
import { SignedIn } from "../components/guard.tsx";
import { Loaded } from "../components/loaded.tsx";
import { PlaceholderCard, PlaceholderRows } from "../components/placeholder.tsx";
import { Shell } from "../components/shell.tsx";
import { artifactHref } from "../paths.ts";
import { usePoll } from "../poll.ts";
import { me } from "../session.ts";
import { useTitle } from "../title.ts";

function Review() {
  const poll = usePoll<HomeData>("/api/home", 60_000);
  useTitle("Review");
  return (
    <Shell>
      <div class="top">
        <h1 class="h1 l">Review</h1>
        <a class="av you" href="/settings" aria-label="Settings">
          {me.value?.name[0]}
        </a>
      </div>
      <Loaded
        from={[poll]}
        value={poll.data.value}
        placeholder={
          <>
            <span class="gh" aria-hidden="true">
              Waiting on you
            </span>
            <PlaceholderCard />
            <PlaceholderRows rows={2} />
          </>
        }
      >
        {(home) => (
          <>
            {home.waiting.length > 0 && <span class="gh">Waiting on you</span>}
            {home.waiting.map((card) => (
              <ReviewCard card={card} key={card.id} />
            ))}
            {home.waiting.length === 0 && <div class="empty">Nothing is waiting on you.</div>}
            {home.recent.length > 0 && <span class="gh">Recently viewed</span>}
            {home.recent.length > 0 && (
              <div class="group">
                {home.recent.map((card) => (
                  <a class="li" href={artifactHref(card)} key={card.id}>
                    <span class="kind">
                      <FileText />
                    </span>
                    <div class="grow">
                      <div class="tt">{card.title}</div>
                      <div class="ss">{card.project}</div>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </Loaded>
    </Shell>
  );
}

export const Home = () => (
  <SignedIn>
    <Review />
  </SignedIn>
);
