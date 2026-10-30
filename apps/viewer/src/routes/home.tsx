import type { Meta } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";

type State = { kind: "loading" } | { kind: "ready"; meta: Meta } | { kind: "failed" };

/** A placeholder: it shows the viewer talking to the server. The real Review home arrives in M4. */
export function Home() {
  const state = useSignal<State>({ kind: "loading" });

  useEffect(() => {
    fetch("/api/meta")
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<Meta>;
      })
      .then((meta) => {
        state.value = { kind: "ready", meta };
      })
      .catch(() => {
        state.value = { kind: "failed" };
      });
  }, [state]);

  const current = state.value;
  return (
    <main class="page">
      <h1 class="title">
        {current.kind === "ready" && current.meta.orgName ? current.meta.orgName : "Artifacts"}
      </h1>
      {current.kind === "failed" && <p class="sub">The server isn't answering.</p>}
      {current.kind === "ready" && !current.meta.orgName && (
        <p class="sub">This deployment isn't set up yet.</p>
      )}
      {current.kind === "ready" && <p class="sub">Server version {current.meta.version}</p>}
    </main>
  );
}
