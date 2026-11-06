import type { IdentityList, SessionRow } from "@artifacts/schema";
import { PASSWORD_MIN } from "@artifacts/schema/constants";
import { useSignal } from "@preact/signals";
import { ChevronRight, KeyRound, Laptop, Plus, Trash2 } from "lucide-preact";
import { useLocation } from "preact-iso";
import { del, post } from "../../api.ts";
import { googleLink, useAction } from "../../components/reauth.tsx";
import { Sheet } from "../../components/sheet.tsx";
import { ago } from "../../format.ts";
import { googleAnswer } from "../../google.ts";
import { addPasskey, passkeyName } from "../../passkey.ts";
import { usePoll } from "../../poll.ts";
import { meta } from "../../session.ts";
import type { Infer } from "../../types.ts";
import { Frame, isAdmin } from "./frame.tsx";

type Keys = {
  passkeys: { id: string; name: string | null; createdAt: string; lastUsedAt: string | null }[];
  passwordSetAt: string | null;
};

export function SignInSettings() {
  const keys = usePoll<Keys>("/api/me/passkeys", 60_000);
  const sessions = usePoll<Infer<typeof SessionRow>[]>("/api/me/sessions", 60_000);
  const google = usePoll<IdentityList>("/api/me/identities", 60_000);
  const { query } = useLocation();
  const action = useAction();
  const changing = useSignal(false);
  const password = useSignal("");
  const add = () =>
    action.run(async () => {
      await addPasskey(passkeyName());
      await keys.refresh();
    });
  const others = meta.value?.viewerOrigins.map((origin) => new URL(origin).hostname).join(" and ");
  const answer = googleAnswer("settings", query.google);
  return (
    <Frame title="Sign-in">
      <span class="gh">Passkeys</span>
      {(keys.data.value?.passkeys.length ?? 0) > 0 && (
        <div class="group">
          {keys.data.value?.passkeys.map((key) => (
            <div class="li" key={key.id}>
              <KeyRound />
              <div class="grow">
                <div class="tt">{key.name}</div>
                <div class="ss">Added {ago(key.createdAt)}</div>
              </div>
              <button
                type="button"
                class="icon-btn"
                aria-label={`Remove ${key.name}`}
                onClick={() =>
                  action.run(async () => {
                    await del(`/api/me/passkeys/${key.id}`);
                    await keys.refresh();
                  })
                }
              >
                <Trash2 />
              </button>
            </div>
          ))}
        </div>
      )}
      <button type="button" class="btn ink" onClick={add}>
        <Plus />
        Add a passkey
      </button>
      <p class="fn">Works on {others}.</p>
      {isAdmin() && (
        <div class="group">
          <a class="li" href="/settings/google">
            <div class="grow">
              <div class="tt">Google sign-in</div>
              <div class="ss">For everyone in {meta.value?.orgName}</div>
            </div>
            <ChevronRight class="chev" />
          </a>
        </div>
      )}
      {action.error.value && <p class="err">{action.error.value}</p>}
      {google.data.value?.google && (
        <>
          <span class="gh">Google</span>
          {google.data.value.identities.length > 0 ? (
            <div class="group">
              {google.data.value.identities.map((row) => (
                <div class="li" key={row.id}>
                  <div class="grow">
                    <div class="tt" style="overflow-wrap:anywhere">
                      {row.email}
                    </div>
                    <div class="ss">{row.lastUsedAt ? `Used ${ago(row.lastUsedAt)}` : "Not used yet"}</div>
                  </div>
                  <button
                    type="button"
                    class="icon-btn"
                    aria-label={`Remove ${row.email}`}
                    onClick={() =>
                      action.run(async () => {
                        await del(`/api/me/identities/${row.id}`);
                        await google.refresh();
                      })
                    }
                  >
                    <Trash2 />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <button
              type="button"
              class="btn soft"
              onClick={() =>
                action.run(async () => {
                  // Asks for a recent sign-in first, because a redirect can't come back to a retry.
                  await post("/api/auth/reauth/check");
                  location.href = googleLink("link", "/settings/sign-in");
                })
              }
            >
              Connect Google
            </button>
          )}
        </>
      )}
      {answer && <p class="fn">{answer}</p>}
      <span class="gh">Password</span>
      <div class="group">
        <button
          type="button"
          class="li btn-li"
          onClick={() => {
            changing.value = true;
          }}
        >
          <div class="grow">
            <div class="tt">{keys.data.value?.passwordSetAt ? "Change password" : "Set a password"}</div>
            {keys.data.value?.passwordSetAt && <div class="ss">Set {ago(keys.data.value.passwordSetAt)}</div>}
          </div>
          <ChevronRight class="chev" />
        </button>
      </div>
      <span class="gh">Signed in on</span>
      <div class="group">
        {sessions.data.value?.map((row) => (
          <div class="li" key={row.id}>
            <Laptop />
            <div class="grow">
              <div class="tt">{row.name}</div>
              <div class="ss">
                {row.kind === "connector" && "Connector, "}
                {row.current ? "This browser" : row.lastSeenAt ? ago(row.lastSeenAt) : "Not used yet"}
              </div>
            </div>
            {!row.current && (
              <button
                type="button"
                class="btn soft fit"
                onClick={() =>
                  action.run(async () => {
                    await del(`/api/me/sessions/${row.id}`);
                    await sessions.refresh();
                  })
                }
              >
                End
              </button>
            )}
          </div>
        ))}
      </div>
      {changing.value && (
        <Sheet
          title="Change password"
          onClose={() => {
            changing.value = false;
          }}
        >
          <label class="gh" for="new-password">
            New password
          </label>
          <input
            id="new-password"
            class="field"
            type="password"
            autocomplete="new-password"
            minLength={PASSWORD_MIN}
            value={password.value}
            onInput={(e) => {
              password.value = e.currentTarget.value;
            }}
          />
          <p class="fn">At least {PASSWORD_MIN} characters. Your other sign-ins end when you save.</p>
          <button
            type="button"
            class="btn ink"
            disabled={password.value.length < PASSWORD_MIN}
            onClick={() =>
              action.run(async () => {
                await post("/api/me/password", { password: password.value });
                changing.value = false;
                password.value = "";
                await Promise.all([keys.refresh(), sessions.refresh()]);
              })
            }
          >
            Save password
          </button>
        </Sheet>
      )}
      {action.sheet}
    </Frame>
  );
}
