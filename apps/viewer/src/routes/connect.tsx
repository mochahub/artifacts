import { useSignal } from "@preact/signals";
import { Cable } from "lucide-preact";
import { useEffect } from "preact/hooks";
import { useLocation } from "preact-iso";
import { ApiFailure, api, post } from "../api.ts";
import { ReauthSheet } from "../components/reauth.tsx";
import { me } from "../session.ts";

type Consent = {
  client: string;
  clientId: string;
  redirectHost: string;
  local: boolean;
  scopes: string[];
  resource: string;
};

const MEANS: Record<string, string> = {
  read: "Search and read what you can see",
  comment: "Comment and reply as you",
  publish: "Publish new versions as you",
};

/** "Connect an app": a client's OAuth request, in the same plain style as approving the CLI. */
export function Connect() {
  const { route, url } = useLocation();
  const consent = useSignal<Consent | null>(null);
  const error = useSignal<string | null>(null);
  const reauth = useSignal(false);
  const search = url.slice(url.indexOf("?"));

  useEffect(() => {
    if (!me.value) {
      route(`/sign-in?next=${encodeURIComponent(url)}`, true);
      return;
    }
    api<Consent>(`/api/oauth/consent${search}`).then(
      (body) => {
        consent.value = body;
      },
      (failure) => {
        error.value = failure instanceof ApiFailure ? failure.message : "Something went wrong.";
      },
    );
  }, [route, url, search]);

  async function decide(approve: boolean) {
    error.value = null;
    try {
      const request = Object.fromEntries(new URLSearchParams(search));
      const { redirect } = await post<{ redirect: string }>("/api/oauth/consent", { approve, request });
      window.location.assign(redirect);
    } catch (failure) {
      if (failure instanceof ApiFailure && failure.code === "recent_auth_required") reauth.value = true;
      else error.value = failure instanceof ApiFailure ? failure.message : "Something went wrong.";
    }
  }

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
      {error.value && <p class="err">{error.value}</p>}
      {body && (
        <>
          <div class="group">
            {body.scopes.map((scope) => (
              <div class="li" key={scope}>
                <div class="grow">
                  <div class="tt">{MEANS[scope] ?? scope}</div>
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
      {reauth.value && (
        <ReauthSheet
          onCancel={() => {
            reauth.value = false;
          }}
          onDone={() => {
            reauth.value = false;
            void decide(true);
          }}
        />
      )}
    </main>
  );
}
