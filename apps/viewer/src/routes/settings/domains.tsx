import { Globe, KeyRound, Lock } from "lucide-preact";
import { Loaded } from "../../components/loaded.tsx";
import { PlaceholderRows } from "../../components/placeholder.tsx";
import { usePoll } from "../../poll.ts";
import { Frame } from "./frame.tsx";
import type { Org } from "./org.tsx";

export function Domains() {
  const org = usePoll<Org>("/api/org", 60_000);
  return (
    <Frame title="Domains">
      <Loaded from={[org]} value={org.data.value?.domains} placeholder={<PlaceholderRows rows={3} />}>
        {(d) => <List domains={d} />}
      </Loaded>
    </Frame>
  );
}

function List({ domains: d }: { domains: Org["domains"] }) {
  const primary = new URL(d.publicUrl).hostname;
  const others = d.moreUrls.map((url) => new URL(url).hostname).filter((host) => host !== d.home);
  return (
    <>
      <span class="gh">Viewer</span>
      <div class="group">
        <div class="li">
          <Globe />
          <div class="grow">
            <div class="tt" style="overflow-wrap:anywhere">
              {primary}
            </div>
            <div class="ss">Used in links you copy</div>
          </div>
          <span class="word ok">Primary</span>
        </div>
        {others.map((host) => (
          <div class="li" key={host}>
            <Globe />
            <div class="grow">
              <div class="tt" style="overflow-wrap:anywhere">
                {host}
              </div>
            </div>
          </div>
        ))}
        <div class="li">
          <KeyRound />
          <div class="grow">
            <div class="tt" style="overflow-wrap:anywhere">
              {d.home}
            </div>
            <div class="ss">Home of your passkeys. Keep it attached</div>
          </div>
        </div>
      </div>
      <span class="gh">Live previews</span>
      <div class="group">
        <div class="li">
          <Lock />
          <div class="grow">
            <div class="tt" style="overflow-wrap:anywhere">
              {d.contentUrl ? new URL(d.contentUrl).hostname : "Not set up"}
            </div>
            <div class="ss">Where interactive frames run, walled off from your account</div>
          </div>
        </div>
      </div>
      <p class="fn">
        Passkeys made on the home domain also work on your other domains in Safari on iOS 18+, Chrome 128+ and
        Firefox 152+. Older browsers use the password.
      </p>
    </>
  );
}
