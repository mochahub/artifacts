import type { ArtifactCard } from "@artifacts/schema";
import { Check } from "lucide-preact";
import { agentInitials, agentShort, ago, plural, renderUrl } from "../format.ts";

export function AgentMark({ agent, small }: { agent: string; small?: boolean }) {
  return <span class={`av agent${small ? " sm" : ""}`}>{agentInitials(agent)}</span>;
}

export function Byline({ card }: { card: ArtifactCard }) {
  return (
    <div class="who">
      {card.agent && <AgentMark agent={card.agent} small />}
      {agentShort(card.agent ?? card.publishedBy)} published v{card.latestVersion}, {ago(card.publishedAt)}
    </div>
  );
}

export function StatusWord({ card }: { card: ArtifactCard }) {
  const { status } = card;
  if (status.kind === "waiting") return <span class="word mark">Waiting on you</span>;
  if (status.kind === "with_agent") {
    return <span class="word agent">With {status.agent ? agentShort(status.agent) : "the agent"}</span>;
  }
  if (status.kind === "approved") {
    return (
      <span class="word ok">
        <Check />
        Approved v{status.version}
      </span>
    );
  }
  return <span class="word">Not reviewed yet</span>;
}

export function Cover({ card }: { card: ArtifactCard }) {
  if ("renderHash" in card.cover) {
    return (
      <span class="th cover">
        <img src={renderUrl(card.id, card.cover.renderHash)} alt="" loading="lazy" />
      </span>
    );
  }
  return <div class="paper">{card.title}</div>;
}

export function ReviewCard({ card }: { card: ArtifactCard }) {
  return (
    <a class="card pad" href={`/${card.project}/${card.slug}`}>
      <Cover card={card} />
      <div>
        <div class="t3">{card.title}</div>
        <Byline card={card} />
      </div>
      <div class="words">
        {card.counts.changedFrames > 0 && (
          <span class="word agent">{plural(card.counts.changedFrames, "frame")} changed</span>
        )}
        {card.counts.repliesToYou > 0 && (
          <span class="word agent">{plural(card.counts.repliesToYou, "reply", "replies")} to you</span>
        )}
        {card.counts.open > 0 && <span class="word mark">{card.counts.open} open</span>}
      </div>
    </a>
  );
}

export function ArtifactTile({ card }: { card: ArtifactCard }) {
  return (
    <a class="card tile" href={`/${card.project}/${card.slug}`}>
      <Cover card={card} />
      <div class="body">
        <div class="name">{card.title}</div>
        <div class="ss">{plural(card.pageCount, "page")}</div>
        <StatusWord card={card} />
      </div>
    </a>
  );
}
