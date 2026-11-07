import type { WikiFinding, WikiPage, WikiSpace } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { ChevronLeft, Search, Share, ShieldAlert } from "lucide-preact";
import { AgentMark } from "../components/cards.tsx";
import { Gate, Loaded } from "../components/loaded.tsx";
import { PlaceholderRows } from "../components/placeholder.tsx";
import { ProjectShareSheet } from "../components/share.tsx";
import { Shell } from "../components/shell.tsx";
import { agentShort, ago, plural } from "../format.ts";
import { artifactHref } from "../paths.ts";
import { usePoll } from "../poll.ts";
import { useTitle } from "../title.ts";
import "./wiki.css";

function host(origin: string | null) {
  try {
    return origin ? new URL(origin).host : null;
  } catch {
    return null;
  }
}

export function WikiHome({ slug }: { slug: string }) {
  const poll = usePoll<WikiSpace>(`/api/wikis/${encodeURIComponent(slug)}`, 60_000);
  const q = useSignal("");
  const sharing = useSignal(false);
  useTitle(poll.data.value?.project.name);
  const href = (slug: string) => artifactHref({ project: poll.data.value?.project.slug ?? "", slug });
  const matches = (page: WikiPage) =>
    `${page.title} ${page.summary ?? ""}`.toLocaleLowerCase().includes(q.value.trim().toLocaleLowerCase());
  const row = (page: WikiPage) => (
    <a class="li" href={href(page.slug)} key={page.slug}>
      <div class="grow">
        <div class="tt">{page.title}</div>
        {page.summary && <div class="ss">{page.summary}</div>}
        <div class="ss wiki-meta">
          {ago(page.updatedAt)}, by {page.publishedBy}
          {page.agent && (
            <span class="word agent">
              <AgentMark />
              {agentShort(page.agent)}
            </span>
          )}
        </div>
        {/* Only what's there: a row of zeros on every page is noise on a phone. */}
        {(page.role === "source" ? page.origin : page.backlinks || page.open) ? (
          <div class="ss">
            {page.role === "source"
              ? host(page.origin)
              : [
                  page.backlinks > 0 && `Linked from ${plural(page.backlinks, "page")}`,
                  page.open > 0 && plural(page.open, "open comment"),
                ]
                  .filter(Boolean)
                  .join(", ")}
          </div>
        ) : null}
        {page.untrusted && (
          <span class="word">
            <ShieldAlert />
            Untrusted
          </span>
        )}
      </div>
    </a>
  );
  const labels: Record<WikiFinding["kind"], string> = {
    wanted: "Not written yet",
    orphan: "No links here",
    stale: "Sources updated",
    unsourced: "No sources",
    untrusted: "Untrusted sources",
  };
  return (
    <Gate from={[poll]}>
      <Shell>
        <a class="back" href="/projects">
          <ChevronLeft />
          Projects
        </a>
        <Loaded from={[poll]} value={poll.loading ? null : poll.data.value} placeholder={<PlaceholderRows />}>
          {(wiki) => (
            <>
              <div>
                <div class="row">
                  <h1 class="h1 grow">{wiki.project.name}</h1>
                  {wiki.project.canShare && (
                    <button
                      type="button"
                      class="icon-btn"
                      aria-label="Share"
                      onClick={() => {
                        sharing.value = true;
                      }}
                    >
                      <Share />
                    </button>
                  )}
                </div>
                <div class="ss" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  {wiki.project.audience.label}
                </div>
              </div>
              <section class="wiki-section">
                <h2 class="t3">Rules</h2>
                {wiki.rules ? (
                  <div class="group">{row(wiki.rules)}</div>
                ) : (
                  <p class="ss">No rules yet. Agents will write them as this wiki takes shape.</p>
                )}
              </section>
              <label class="search">
                <Search />
                <input
                  aria-label="Find in wiki"
                  placeholder="Find in wiki"
                  value={q.value}
                  onInput={(e) => {
                    q.value = e.currentTarget.value;
                  }}
                />
              </label>
              <section class="wiki-section">
                <h2 class="t3">Pages</h2>
                {wiki.pages.some(matches) ? (
                  <div class="group">{wiki.pages.filter(matches).map(row)}</div>
                ) : (
                  <p class="ss">
                    {q.value
                      ? "No pages match."
                      : "No pages yet. Pages agents publish here will appear here."}
                  </p>
                )}
              </section>
              <section class="wiki-section">
                <h2 class="t3">Sources</h2>
                {wiki.sources.some(matches) ? (
                  <div class="group">
                    {wiki.sources
                      .filter(matches)
                      .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
                      .map(row)}
                  </div>
                ) : (
                  <p class="ss">
                    {q.value
                      ? "No sources match."
                      : "No sources yet. Documents and web clips agents bring in will appear here."}
                  </p>
                )}
              </section>
              <section class="wiki-section">
                <h2 class="t3">Needs attention</h2>
                {wiki.garden.length === 0 && <p class="ss">Nothing needs attention yet.</p>}
                {(Object.keys(labels) as WikiFinding["kind"][]).map((kind) => {
                  const findings = wiki.garden.filter((finding) => finding.kind === kind);
                  return (
                    findings.length > 0 && (
                      <div key={kind}>
                        <h3 class="gh">{labels[kind]}</h3>
                        <div class="group">
                          {findings.map((finding) => (
                            <div class="li" key={finding.slug}>
                              <div class="grow">
                                {kind === "wanted" ? (
                                  <div class="tt">{finding.slug}</div>
                                ) : (
                                  <a class="wiki-link tt" href={href(finding.slug)}>
                                    {wiki.pages.find((page) => page.slug === finding.slug)?.title ??
                                      finding.slug}
                                  </a>
                                )}
                                <div class="ss">{finding.message}</div>
                                {finding.refs.length > 0 && (
                                  <div class="ss">
                                    {kind === "wanted" ? "Linked from: " : "Sources: "}
                                    {finding.refs.map((ref, i) => (
                                      <span key={ref}>
                                        {i > 0 && ", "}
                                        <a class="wiki-link" href={href(ref)}>
                                          {[
                                            ...wiki.pages,
                                            ...wiki.sources,
                                            ...(wiki.rules ? [wiki.rules] : []),
                                          ].find((page) => page.slug === ref)?.title ?? ref}
                                        </a>
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  );
                })}
              </section>
              <section class="wiki-section">
                <h2 class="t3">Recent changes</h2>
                {wiki.log.length === 0 ? (
                  <p class="ss">No changes yet.</p>
                ) : (
                  <div class="group">
                    {wiki.log.map((entry, i) => (
                      <div class="li" key={`${entry.at}-${i}`}>
                        <div class="grow">
                          {entry.slug ? (
                            <a class="wiki-link tt" href={href(entry.slug)}>
                              {entry.title ?? entry.slug}
                            </a>
                          ) : (
                            <div class="tt">{entry.title ?? "Wiki updated"}</div>
                          )}
                          <div class="ss">
                            {entry.kind.replaceAll("_", " ")}
                            {entry.version !== null && `, v${entry.version}`}, {ago(entry.at)}, by {entry.by}
                          </div>
                          {entry.agent && (
                            <span class="word agent">
                              <AgentMark />
                              {agentShort(entry.agent)}
                            </span>
                          )}
                          {entry.message && <div class="ss">{entry.message}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </Loaded>
        {sharing.value && (
          <ProjectShareSheet
            slug={slug}
            wiki
            onClose={() => {
              sharing.value = false;
            }}
            onChanged={poll.refresh}
          />
        )}
      </Shell>
    </Gate>
  );
}
