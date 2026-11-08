import type { LibrarianProposal } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { useRoute } from "preact-iso";
import { api, post } from "../api.ts";
import { SignedIn } from "../components/guard.tsx";
import { Frame } from "../routes/settings/frame.tsx";
import { safeError } from "./common.ts";
import "./librarian.css";
export function Proposal() {
  return (
    <SignedIn>
      <Review />
    </SignedIn>
  );
}
function Review() {
  const { params } = useRoute();
  const base = `/api/wikis/${encodeURIComponent(params.wiki ?? "")}/proposals/${encodeURIComponent(params.id ?? "")}`;
  const proposal = useSignal<LibrarianProposal | null>(null),
    error = useSignal(""),
    busy = useSignal(false),
    notice = useSignal("");
  const requestId = useSignal(crypto.randomUUID());
  async function load() {
    proposal.value = await api<LibrarianProposal>(base);
  }
  async function perform(work: () => Promise<void>) {
    busy.value = true;
    error.value = "";
    try {
      await work();
    } catch (failure) {
      error.value = safeError(failure);
    } finally {
      busy.value = false;
    }
  }
  useEffect(() => {
    perform(load);
  }, [base]);
  const p = proposal.value;
  return (
    <Frame
      title="Review proposed page"
      back={`/wikis/${encodeURIComponent(params.wiki ?? "")}/inbox`}
      backLabel="Sources"
    >
      <div class="librarian">
        <p class="agent-output">Librarian proposal. Based on untrusted sources.</p>
        {p && (
          <>
            <h2 class="h2">{p.title}</h2>
            <p>{p.summary}</p>
            <pre>{p.markdown}</pre>
            <p>Status: {p.status}</p>
            <p>
              Check the claims against their sources before creating this page. Existing suggestions and
              threads remain open.
            </p>
            {p.status === "open" && (
              <div class="row">
                <button
                  class="btn human"
                  disabled={busy.value}
                  type="button"
                  onClick={() =>
                    perform(async () => {
                      await post(`${base}/create`, { requestId: requestId.value, expectedStatus: "open" });
                      notice.value = "Page created.";
                      await load();
                    })
                  }
                >
                  Create page
                </button>
                <button
                  class="btn soft"
                  disabled={busy.value}
                  type="button"
                  onClick={() =>
                    perform(async () => {
                      await post(`${base}/reject`, { expectedStatus: "open" });
                      await load();
                    })
                  }
                >
                  Reject proposal
                </button>
              </div>
            )}
          </>
        )}
        {error.value && (
          <p role="alert">{error.value} Proposal review may not be available on this server.</p>
        )}
        {notice.value && <p role="status">{notice.value}</p>}
        <button class="btn soft" type="button" disabled={busy.value} onClick={() => perform(load)}>
          Refresh proposal
        </button>
      </div>
    </Frame>
  );
}
