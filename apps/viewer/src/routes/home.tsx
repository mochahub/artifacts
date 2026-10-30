import { useEffect } from "preact/hooks";
import { useLocation } from "preact-iso";
import { post } from "../api.ts";
import { me, meta } from "../session.ts";

/** A placeholder until the real Review home in M4. */
export function Home() {
  const { route } = useLocation();
  useEffect(() => {
    if (!me.value) route("/sign-in", true);
  }, [route]);
  if (!me.value) return null;
  return (
    <main class="screen">
      <h1 class="h1">{meta.value?.orgName}</h1>
      <p class="sub">Signed in as {me.value.name}.</p>
      <button
        type="button"
        class="btn soft"
        onClick={async () => {
          await post("/api/auth/logout");
          me.value = null;
          route("/sign-in", true);
        }}
      >
        Sign out
      </button>
    </main>
  );
}
