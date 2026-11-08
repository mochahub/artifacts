import { PURGE_DAYS } from "@artifacts/schema/constants";
import { ChevronRight } from "lucide-preact";
import type { JSX } from "preact";
import { lazy, useRoute } from "preact-iso";
import { post } from "../../api.ts";
import { SignedIn } from "../../components/guard.tsx";
import { useAction } from "../../components/reauth.tsx";
import { forgetDrafts } from "../../editing/forget.ts";
import { clearOffline, turnOffNotifications } from "../../notify.ts";
import { useTitle } from "../../title.ts";
import { BrandSettings } from "./brand.tsx";
import { Domains } from "./domains.tsx";
import { Frame, isAdmin, isMemberOrUp } from "./frame.tsx";
import { GoogleSetup } from "./google.tsx";
import { Notifications } from "./notifications.tsx";
import { OrgSettings } from "./org.tsx";
import { People } from "./people.tsx";
import { SignInSettings } from "./sign-in.tsx";
import { TeamDetail, Teams } from "./teams.tsx";
import { Tokens } from "./tokens.tsx";

const LibrarianSettings = lazy(() => import("../../librarian/settings.tsx").then((m) => m.LibrarianSettings));

function Index() {
  const action = useAction();
  const rows = [
    ["/settings/sign-in", "Sign-in", "Passkeys, password and sessions"],
    ["/settings/notifications", "Notifications", "On this device"],
    ...(isMemberOrUp() ? [["/settings/teams", "Teams", "Who works together, and what they share"]] : []),
    ...(isAdmin()
      ? [
          ["/settings/people", "People", "Members, outside people and invites"],
          ["/settings/librarian", "Librarian", "Wiki scope, provider key and spending caps"],
          ["/settings/tokens", "Tokens", "For CI and headless agents"],
          ["/settings/domains", "Domains", "Where this deployment answers"],
          ["/settings/org", "Organization", "Name, defaults and link sharing"],
          ["/settings/brand", "Brand", "How your templates look"],
        ]
      : []),
    ["/settings/deleted", "Recently deleted", `Kept for ${PURGE_DAYS} days`],
  ];
  return (
    <Frame title="Settings" back="/" backLabel="Review">
      <div class="group">
        {rows.map(([href, title, sub]) => (
          <a class="li" href={href} key={href}>
            <div class="grow">
              <div class="tt">{title}</div>
              <div class="ss">{sub}</div>
            </div>
            <ChevronRight class="chev" />
          </a>
        ))}
      </div>
      {action.error.value && <p class="err">{action.error.value}</p>}
      <button
        type="button"
        class="btn soft"
        onClick={() =>
          action.run(async () => {
            // Before the session ends: the next person on this device shouldn't get these.
            await turnOffNotifications().catch(() => {});
            await post("/api/auth/logout");
            await clearOffline();
            await forgetDrafts().catch(() => {});
            location.href = "/sign-in";
          })
        }
      >
        Sign out
      </button>
      {action.sheet}
    </Frame>
  );
}

const PAGES: Record<string, () => JSX.Element | null> = {
  "sign-in": SignInSettings,
  notifications: Notifications,
  people: People,
  teams: Teams,
  google: GoogleSetup,
  domains: Domains,
  org: OrgSettings,
  brand: BrandSettings,
  tokens: Tokens,
  librarian: LibrarianSettings,
};

export function Settings() {
  const { params } = useRoute();
  const Page = (params.section && Object.hasOwn(PAGES, params.section) && PAGES[params.section]) || Index;
  useTitle("Settings");
  return <SignedIn>{params.slug ? <TeamDetail slug={params.slug} /> : <Page />}</SignedIn>;
}
