import type { ConsentRedirect, OAuthConsent } from "@artifacts/schema";
import type { OAuthScope } from "@artifacts/schema/constants";
import { useSignal } from "@preact/signals";
import { Cable } from "lucide-preact";
import { useEffect } from "preact/hooks";
import { useLocation } from "preact-iso";
import { api, message, post } from "../api.ts";
import { useAction } from "../components/reauth.tsx";
import { signInHref } from "../paths.ts";
import { me } from "../session.ts";

const MEANS: Record<OAuthScope, string> = {
  read: "Search and read what you can see",
  comment: "Comment and reply as you",
  publish: "Publish new versions as you",
};

/** "Connect an app": a client's OAuth request, in the same plain style as approving the CLI. */
export function Connect() {
  const { route, url } = useLocation();
  const consent = useSignal<OAuthConsent | null>(null);
  const error = useSignal<string | null>(null);
  const action = useAction();
  const search = url.slice(url.indexOf("?"));

  useEffect(() => {
    if (!me.value) {
      route(signInHref(url), true);
      return;
    }
    api<OAuthConsent>(`/api/oauth/consent${search}`).then(
      (body) => {
        consent.value = body;
      },
      (failure) => {
        error.value = message(failure);
      },
    );
  }, [route, url, search]);

  const decide = (approve: boolean) =>
    action.run(async () => {
      const request = Object.fromEntries(new URLSearchParams(search));
      const { redirect } = await post<ConsentRedirect>("/api/oauth/consent", { approve, request });
      window.location.assign(redirect);
    });

  const body = consent.value;
  return (
    <main class="screen">
      <div class="center">
        <Cable size={40} />
      </div>
      <div class="center">
        <h1 class="h1 m">Connect an app</h1>
        {body && <p class="sub">An app calling itself "{body.client}" wants to use Artifacts as you.</p>}
      </div>
      {(error.value ?? action.error.value) && <p class="err">{error.value ?? action.error.value}</p>}
      {body && (
        <>
          <div class="group">
            {body.scopes.map((scope) => (
              <div class="li" key={scope}>
                <div class="grow">
                  <div class="tt">{Object.hasOwn(MEANS, scope) ? MEANS[scope as OAuthScope] : scope}</div>
                </div>
              </div>
            ))}
          </div>
          <p class="fn">
            It can't resolve threads, approve versions, delete anything for good or change settings.
          </p>
          <p class="fn">
            Your approval goes to <b>{body.redirectHost}</b>.
            {body.local &&
              " That's a program on your own machine, and any program there could use this name. Only continue if you just started this."}
          </p>
          <button class="btn ink" type="button" onClick={() => decide(true)}>
            Connect
          </button>
          <button class="btn soft" type="button" onClick={() => decide(false)}>
            Don't connect
          </button>
        </>
      )}
      {action.sheet}
    </main>
  );
}
