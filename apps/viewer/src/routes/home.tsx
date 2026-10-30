import type { Home as HomeData } from "@artifacts/schema";
import { FileText } from "lucide-preact";
import { ReviewCard } from "../components/cards.tsx";
import { Shell } from "../components/shell.tsx";
import { usePoll } from "../poll.ts";
import { me } from "../session.ts";
import { SignedIn } from "./guard.tsx";

function Review() {
  const { data } = usePoll<HomeData>("/api/home", 60_000);
  const home = data.value;
  return (
    <Shell>
      <div class="top">
        <h1 class="h1 l">Review</h1>
        <a class="av you" href="/settings" aria-label="Settings">
          {me.value?.name[0]}
        </a>
      </div>
      {home && home.waiting.length > 0 && <span class="gh">Waiting on you</span>}
      {home?.waiting.map((card) => (
        <ReviewCard card={card} key={card.id} />
      ))}
      {home && home.waiting.length === 0 && <div class="empty">Nothing is waiting on you.</div>}
      {home && home.recent.length > 0 && <span class="gh">Recently viewed</span>}
      {home && home.recent.length > 0 && (
        <div class="group">
          {home.recent.map((card) => (
            <a class="li" href={`/${card.project}/${card.slug}`} key={card.id}>
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
    </Shell>
  );
}

export const Home = () => (
  <SignedIn>
    <Review />
  </SignedIn>
);
