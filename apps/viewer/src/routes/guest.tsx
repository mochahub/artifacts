import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { useLocation, useRoute } from "preact-iso";
import { ApiFailure, api, post } from "../api.ts";

type Preview = {
  artifact: {
    id: string;
    project: string;
    slug: string;
    title: string;
    cover: { renderHash: string } | { title: string };
  };
  permission: "view" | "comment";
  needsName: boolean;
  sharedBy: string;
};

/** Name entry, then the artifact (05·2). A plain edge under the cover, not the mock's gradient. */
export function GuestLanding() {
  const { params } = useRoute();
  const { route } = useLocation();
  const preview = useSignal<Preview | null>(null);
  const gone = useSignal(false);
  const name = useSignal("");
  const error = useSignal<string | null>(null);
  const token = encodeURIComponent(params.token ?? "");
  const open = (body: Preview) => route(`/${body.artifact.project}/${body.artifact.slug}`, true);

  useEffect(() => {
    api<Preview>(`/api/s/${token}`)
      .then((body) => {
        if (body.needsName) preview.value = body;
        else open(body);
      })
      .catch(() => {
        gone.value = true;
      });
  }, [token]);

  async function start(event: SubmitEvent) {
    event.preventDefault();
    try {
      await post(`/api/s/${token}/guest`, { name: name.value });
      if (preview.value) open(preview.value);
    } catch (failure) {
      error.value = failure instanceof ApiFailure ? failure.message : "Something went wrong.";
    }
  }

  if (gone.value) {
    return (
      <main class="screen">
        <h1 class="h1 m">This link no longer works</h1>
        <p class="sub">Ask whoever sent it for a new one.</p>
      </main>
    );
  }
  const body = preview.value;
  if (!body) return null;
  return (
    <main class="screen">
      {"renderHash" in body.artifact.cover && (
        <span class="th cover" style="height:220px">
          <img src={`/api/s/${token}/cover`} alt="" />
        </span>
      )}
      <p class="sub">{body.sharedBy} shared this with you</p>
      <h1 class="h1">{body.artifact.title}</h1>
      <form style="display:flex;flex-direction:column;gap:16px" onSubmit={start}>
        <label class="gh" for="guest-name">
          Your name
        </label>
        <input
          id="guest-name"
          class="field"
          autocomplete="name"
          required
          maxLength={60}
          value={name.value}
          onInput={(e) => {
            name.value = e.currentTarget.value;
          }}
        />
        {error.value && <p class="err">{error.value}</p>}
        <button class="btn ink" type="submit">
          Start reviewing
        </button>
      </form>
    </main>
  );
}
