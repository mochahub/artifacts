import type { Artifact } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { Archive, History, Share, Trash2 } from "lucide-preact";
import { useLocation } from "preact-iso";
import { ApiFailure, post } from "../api.ts";
import { plural } from "../format.ts";
import { Sheet } from "./sheets.tsx";

const message = (failure: unknown) =>
  failure instanceof ApiFailure ? failure.message : "Something went wrong.";

/** The artifact menu (07·1). Each row says what it does before you commit to it. */
export function ArtifactMenu({
  artifact,
  onClose,
  onChanged,
  onShare,
  onHistory,
}: {
  artifact: Artifact;
  onClose(): void;
  onChanged(): void;
  onShare(): void;
  onHistory(): void;
}) {
  const { route } = useLocation();
  const deleting = useSignal(false);
  const error = useSignal<string | null>(null);

  async function archive() {
    try {
      await post(`/api/artifacts/${artifact.id}/${artifact.archivedAt ? "unarchive" : "archive"}`);
      onChanged();
      onClose();
    } catch (failure) {
      error.value = message(failure);
    }
  }
  async function remove() {
    try {
      await post(`/api/artifacts/${artifact.id}/delete`);
      route(`/${artifact.project}`);
    } catch (failure) {
      error.value = message(failure);
    }
  }

  if (deleting.value) {
    return (
      <Sheet title={`Delete ${artifact.title}?`} onClose={onClose}>
        <p class="sub">It moves to Recently deleted for 30 days, then these are erased for good:</p>
        <div class="group">
          <div class="li">
            <div class="grow">
              <div class="tt">
                {plural(artifact.latestVersion, "version")} and {plural(artifact.pages.length, "page")}
              </div>
            </div>
          </div>
          <div class="li">
            <div class="grow">
              <div class="tt">{plural(artifact.counts.open, "open comment")} and every other comment</div>
            </div>
          </div>
          <div class="li">
            <div class="grow">
              <div class="tt">{artifact.hasBackend ? "Saved data and its backend" : "Any saved data"}</div>
            </div>
          </div>
          <div class="li">
            <div class="grow">
              <div class="tt">Share links stop now</div>
            </div>
          </div>
        </div>
        {error.value && <p class="err">{error.value}</p>}
        <button type="button" class="btn soft" style="color:var(--warn-word)" onClick={remove}>
          Delete
        </button>
        {!artifact.archivedAt && (
          <button type="button" class="btn" onClick={archive}>
            Archive instead
          </button>
        )}
      </Sheet>
    );
  }

  return (
    <Sheet title={artifact.title} onClose={onClose}>
      <div class="group">
        {artifact.permissions.share && !artifact.archivedAt && (
          <button type="button" class="li btn-li" onClick={onShare}>
            <Share />
            <div class="grow">
              <div class="tt">Share</div>
            </div>
          </button>
        )}
        <button type="button" class="li btn-li" onClick={onHistory}>
          <History />
          <div class="grow">
            <div class="tt">Version history</div>
          </div>
        </button>
      </div>
      {artifact.permissions.manage && (
        <div class="group">
          <button type="button" class="li btn-li" onClick={archive}>
            <Archive />
            <div class="grow">
              <div class="tt">{artifact.archivedAt ? "Unarchive" : "Archive"}</div>
              <div class="ss">
                {artifact.archivedAt
                  ? "Back to normal: comments and versions work again."
                  : "Read-only. Links keep working."}
              </div>
            </div>
          </button>
          <button
            type="button"
            class="li btn-li"
            onClick={() => {
              deleting.value = true;
            }}
          >
            <Trash2 />
            <div class="grow">
              <div class="tt" style="color:var(--warn-word)">
                Delete
              </div>
              <div class="ss">Goes to Recently deleted for 30 days.</div>
            </div>
          </button>
        </div>
      )}
      {error.value && <p class="err">{error.value}</p>}
    </Sheet>
  );
}

export function ArchivedBanner({ artifact, onChanged }: { artifact: Artifact; onChanged(): void }) {
  if (!artifact.archivedAt) return null;
  const on = new Date(artifact.archivedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <div class="banner">
      <span class="grow">Archived on {on}. Read-only.</span>
      {artifact.permissions.manage && (
        <button
          type="button"
          class="vchip"
          onClick={async () => {
            await post(`/api/artifacts/${artifact.id}/unarchive`);
            onChanged();
          }}
        >
          Unarchive
        </button>
      )}
    </div>
  );
}
