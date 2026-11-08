import type { LibrarianConfig, ProjectRow } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { api, del } from "../api.ts";
import { useAction } from "../components/reauth.tsx";
import { Frame, isAdmin } from "../routes/settings/frame.tsx";
import { safeError } from "./common.ts";
import "./librarian.css";

export function LibrarianSettings() {
  return isAdmin() ? (
    <AdminSettings />
  ) : (
    <Frame title="Librarian">
      <p>Admin access required.</p>
    </Frame>
  );
}
function AdminSettings() {
  const config = useSignal<LibrarianConfig | null>(null);
  const wikis = useSignal<ProjectRow[]>([]);
  const busy = useSignal(false);
  const error = useSignal("");
  const notice = useSignal("");
  const keyInput = useRef<HTMLInputElement>(null);
  const action = useAction();
  async function load() {
    const [body, projects] = await Promise.all([
      api<LibrarianConfig>("/api/librarian/config"),
      api<ProjectRow[]>("/api/projects"),
    ]);
    config.value = body;
    wikis.value = projects.filter((p) => p.kind === "wiki");
  }
  function run(work: () => Promise<unknown>) {
    if (busy.value) return;
    return action.run(async () => {
      busy.value = true;
      error.value = "";
      notice.value = "";
      try {
        await work();
      } catch (failure) {
        // Let the existing sheet handle recent-auth; all other errors stay bounded.
        if (failure instanceof Error && "code" in failure && failure.code === "recent_auth_required")
          throw failure;
        error.value = safeError(failure);
      } finally {
        busy.value = false;
      }
    });
  }
  useEffect(() => {
    run(load);
    return () => {
      if (keyInput.current) keyInput.current.value = "";
    };
  }, []);
  const body = config.value;
  async function write(enabled: boolean, fields = body) {
    if (!body || !fields) return;
    config.value = await api<LibrarianConfig>("/api/librarian/config", {
      method: "PUT",
      json: {
        expectedGeneration: body.generation,
        enabled,
        wikiIds: fields.wikiIds,
        model: fields.model,
        monthlyLimitMicrousd: fields.monthlyLimitMicrousd,
        runLimitMicrousd: fields.runLimitMicrousd,
      },
    });
    notice.value = enabled ? "Librarian enabled." : "Settings saved. Librarian is off.";
  }
  return (
    <Frame title="Librarian">
      <div class="librarian">
        <p class="ss">Admin only. Saving setup or a key never enables runs.</p>
        <a href="/settings/librarian/runs">Run logs</a>
        {!body && !error.value && <p role="status">Loading settings…</p>}
        {body && (
          <div class="columns">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                const fields = {
                  ...body,
                  wikiIds: data.getAll("wiki").map(String),
                  model: String(data.get("model")),
                  monthlyLimitMicrousd: Math.round(Number(data.get("monthly")) * 1e6),
                  runLimitMicrousd: Math.round(Number(data.get("run")) * 1e6),
                };
                if (
                  fields.wikiIds.length > 100 ||
                  !Number.isSafeInteger(fields.monthlyLimitMicrousd) ||
                  !Number.isSafeInteger(fields.runLimitMicrousd) ||
                  fields.runLimitMicrousd > fields.monthlyLimitMicrousd
                ) {
                  error.value = "Choose at most 100 wikis and a per-run cap no greater than the monthly cap.";
                  return;
                }
                run(() => write(false, fields));
              }}
            >
              <fieldset disabled={busy.value}>
                <legend>Wiki scope</legend>
                <p class="ss">Only selected wikis, at most 100. Empty selection gives no access.</p>
                {wikis.value.map((w) => (
                  <label class="wiki-choice" key={w.id}>
                    <input
                      type="checkbox"
                      name="wiki"
                      value={w.id}
                      defaultChecked={body.wikiIds.includes(w.id)}
                    />
                    {w.name}
                  </label>
                ))}
                {body.wikiIds
                  .filter((id) => !wikis.value.some((w) => w.id === id))
                  .map((id) => (
                    <label class="wiki-choice" key={id}>
                      <input type="checkbox" name="wiki" value={id} defaultChecked />
                      Unavailable selected wiki
                    </label>
                  ))}
              </fieldset>
              <label for="l-model">Model</label>
              <input
                class="field"
                id="l-model"
                name="model"
                required
                maxLength={128}
                key={`model-${body.generation}`}
                defaultValue={body.model}
              />
              <label for="l-month">Monthly cap, USD</label>
              <input
                class="field"
                id="l-month"
                name="monthly"
                type="number"
                required
                min="0"
                step="0.000001"
                key={`month-${body.generation}`}
                defaultValue={body.monthlyLimitMicrousd / 1e6}
              />
              <label for="l-run">Per-run cap, USD</label>
              <input
                class="field"
                id="l-run"
                name="run"
                type="number"
                required
                min="0"
                step="0.000001"
                key={`run-${body.generation}`}
                defaultValue={body.runLimitMicrousd / 1e6}
              />
              <p class="ss">
                New work is held at the cap. Uncertain charges remain counted. Models require an approved rate
                card on the server.
              </p>
              <button type="submit" class="btn ink" disabled={busy.value}>
                Save setup, keep off
              </button>
            </form>
            <section>
              <h2 class="h2">Run controls</h2>
              <strong>Librarian is {body.enabled ? "on" : "off"}</strong>
              <p>Sources can queue while off. No new runs start until an admin explicitly enables it.</p>
              <button
                class="btn soft"
                type="button"
                disabled={
                  busy.value ||
                  body.enabled ||
                  !body.keyConfigured ||
                  !body.wikiIds.length ||
                  body.runLimitMicrousd <= 0
                }
                onClick={() => run(() => write(true))}
              >
                Enable librarian with saved settings
              </button>
              <button
                class="btn soft"
                type="button"
                disabled={busy.value}
                onClick={() => run(() => write(false))}
              >
                Stop all runs and turn off
              </button>
              <p class="ss">
                Stops future work. Committed edits remain; in-flight charges may settle afterward.
              </p>
              <h2 class="h2">Provider key</h2>
              <p>{body.keyConfigured ? "A key is saved. It cannot be displayed." : "No key saved."}</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    // Read only inside the attempt. A recent-auth retry requires fresh entry.
                    const key = keyInput.current?.value ?? "";
                    if (keyInput.current) keyInput.current.value = "";
                    if (!key) {
                      error.value = "Enter the key again after confirming your identity.";
                      return;
                    }
                    await api("/api/librarian/key", {
                      method: "PUT",
                      json: { key, expectedGeneration: config.value?.generation },
                    });
                    await load();
                    notice.value = "Key saved. Librarian is off.";
                  });
                }}
              >
                <label for="l-key">New provider key</label>
                <input
                  ref={keyInput}
                  id="l-key"
                  class="field"
                  type="password"
                  required
                  maxLength={4096}
                  autoComplete="off"
                  spellcheck={false}
                />
                <button type="submit" class="btn soft" disabled={busy.value}>
                  Save key, keep off
                </button>
              </form>
              <button
                type="button"
                class="btn soft"
                disabled={busy.value || !body.keyConfigured}
                onClick={() =>
                  run(async () => {
                    await del("/api/librarian/key", { expectedGeneration: body.generation });
                    await load();
                    notice.value = "Key removed. Librarian is off.";
                  })
                }
              >
                Remove key and turn off
              </button>
            </section>
          </div>
        )}
        {notice.value && <p role="status">{notice.value}</p>}
        {error.value && <p role="alert">{error.value}</p>}
        <button type="button" class="btn soft" disabled={busy.value} onClick={() => run(load)}>
          Refresh settings
        </button>
        {action.sheet}
      </div>
    </Frame>
  );
}
