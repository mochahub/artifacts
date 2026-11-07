import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublishResult } from "@artifacts/schema";
import { BoardEditResult, BoardRead, BoardSuggestionList } from "@artifacts/schema/boards";
import sharp from "sharp";
import type { TestServer } from "../../../apps/server/test/helpers.ts";
import { artifactAt, cli, cliJson, copyFixture, hostedServer, sandbox } from "./sandbox.ts";

/**
 * `artifacts board` against the real routes: a sketch an agent reads, mocks it publishes and places
 * beside it, and the exit codes that tell applied from suggested from refused. Needs the test stack
 * (TEST_DATABASE_URL, TEST_S3_ENDPOINT as for every file that starts a server).
 */
describe("board commands against a server", () => {
  let t: TestServer;
  let url: string;
  let token: string;
  const box = sandbox();
  const agent = () => ({ ...box.env, ARTIFACTS_URL: url, ARTIFACTS_TOKEN: token });
  const work = mkdtempSync(join(tmpdir(), "artifacts-board-e2e-"));
  const file = (name: string, content: string | object) => {
    const path = join(work, name);
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
  };
  const read = async (target: string, ...flags: string[]) => {
    const { untrusted: _, ...whole } = await cliJson(["board", "read", target, ...flags], agent());
    return BoardRead.parse(whole);
  };
  const style = {
    fill: "transparent",
    stroke: "#242424",
    strokeWidth: 2,
    opacity: 1,
    fontSize: 20,
    align: "left",
  };
  const sticky = (text: string, x: number, y: number) => ({
    kind: "sticky",
    text,
    pose: { x, y, w: 200, h: 120, angle: 0 },
    parent: null,
    label: "",
    style: { ...style, fill: "#fff2a8" },
  });

  beforeAll(async () => {
    ({ t, url, token } = await hostedServer());
    // `mine` is read by its owner alone, so an agent's edit applies; `shared` is org-wide, so it becomes a suggestion.
    expect((await cli(["wiki", "create", "mine", "--only-me"], agent())).code).toBe(0);
    expect((await cli(["wiki", "create", "shared"], agent())).code).toBe(0);
    for (const wiki of ["mine", "shared"]) {
      const made = await cli(
        [
          "board",
          "create",
          `${wiki}/map`,
          "--title",
          "Checkout flow",
          "--summary",
          "A sketch and its mocks.",
          "--tags",
          "checkout",
        ],
        agent(),
      );
      expect(made.stderr).toBe("");
      expect(made.stdout).toContain(`✓ ${wiki}/map v1`);
    }
  }, 120_000);
  afterAll(() => t.stop());

  test("an agent reads the draft, adds objects by one batch and gets their lasting ids back", async () => {
    const empty = await read("mine/map", "--draft");
    expect(empty.draft).toBe(true);
    expect(empty.objects).toEqual([]);
    expect(empty.agents.edits).toBe("direct");
    const ops = file("add.json", {
      epoch: empty.epoch,
      ops: [
        { op: "add", ref: "$card", object: sticky("Pay with card", 0, 0) },
        { op: "add", ref: "$ok", object: sticky("Confirm", 360, 0) },
        {
          op: "connect",
          ref: "$arrow",
          label: "",
          style,
          start: { point: { x: 200, y: 60 }, binding: { object: "$card", u: 1, v: 0.5 } },
          end: { point: { x: 360, y: 60 }, binding: { object: "$ok", u: 0, v: 0.5 } },
          route: "straight",
          startArrow: false,
          endArrow: true,
        },
      ],
    });
    const done = await cli(["board", "edit", "mine/map", "--ops", ops, "--json"], agent());
    expect(done.stderr).toBe("");
    expect(done.code).toBe(0);
    const result = BoardEditResult.parse(
      (({ untrusted, requestId, ...rest }) => rest)(JSON.parse(done.stdout)),
    );
    expect(result.outcome).toBe("applied");
    expect(Object.keys(result.ids).sort()).toEqual(["$arrow", "$card", "$ok"]);

    const after = await read("mine/map", "--draft");
    const byId = new Map(after.objects.map((o) => [o.object.id, o]));
    expect(byId.get(result.ids.$card as string)?.object).toMatchObject({
      kind: "sticky",
      text: "Pay with card",
    });
    expect(byId.get(result.ids.$arrow as string)?.object).toMatchObject({
      kind: "connector",
      data: {
        start: { binding: { object: result.ids.$card } },
        end: { binding: { object: result.ids.$ok } },
      },
    });
    // The text form carries the same ids and bases for a model that reads text.
    const text = await cli(["board", "read", "mine/map", "--draft", "--text"], agent());
    expect(text.stdout).toContain(
      `${result.ids.$card} sticky base=${byId.get(result.ids.$card as string)?.base}`,
    );
  }, 60_000);

  test("a stale base is refused with exit 1 and the same request id gets the same receipt", async () => {
    const now = await read("mine/map", "--draft");
    const target = now.objects.find((o) => o.object.kind === "sticky" && o.object.text === "Confirm");
    expect(target).toBeDefined();
    const id = target?.object.id as string;
    const edit = (base: string, text: string, requestId: string) =>
      cli(
        [
          "board",
          "edit",
          "mine/map",
          "--ops",
          file(`edit-${requestId}.json`, {
            epoch: now.epoch,
            bases: { [id]: base },
            ops: [{ op: "update", object: id, patch: { text } }],
          }),
          "--request-id",
          requestId,
          "--json",
        ],
        agent(),
      );
    const first = "11111111-1111-4111-8111-111111111111";
    const applied = await edit(target?.base as string, "Confirm order", first);
    expect(applied.code).toBe(0);
    // The base changed with the text: the old one is stale now.
    const stale = await edit(target?.base as string, "Nope", "22222222-2222-4222-8222-222222222222");
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout)).toMatchObject({ outcome: "refused", reason: "stale" });
    // A retry of the first request returns its stored receipt instead of applying it again.
    const retry = await edit(target?.base as string, "Confirm order", first);
    expect(retry.code).toBe(0);
    expect(JSON.parse(retry.stdout).seq).toBe(JSON.parse(applied.stdout).seq);
  }, 60_000);

  test("publish the rendered frames, then place one beside the sketch", async () => {
    const dir = copyFixture(join(import.meta.dir, "fixtures/boards-cli/mocks"));
    const published = await cli(["publish", "--json", "-m", "Mocks"], agent(), dir);
    expect(published.stderr).not.toContain("✗");
    expect(published.code).toBe(0);
    const result = PublishResult.parse(JSON.parse(published.stdout));
    // The page a board is on is `board`, and this folder publishes to that artifact's slug.
    expect(result.version).toBeGreaterThan(1);
    expect([...(result.board?.placed ?? []), ...(result.board?.unplaced ?? [])].length).toBe(2);

    const sketch = (await read("mine/map", "--draft")).objects.find(
      (o) => o.object.kind === "sticky" && o.object.text === "Pay with card",
    );
    const placed = await cli(
      [
        "board",
        "place-frame",
        "mine/map",
        "--frame",
        "login",
        "--near",
        sketch?.object.id as string,
        "--side",
        "below",
        "--gap",
        "60",
        "--checkpoint",
        "--json",
      ],
      agent(),
    );
    expect(placed.stderr).toBe("");
    expect(placed.code).toBe(0);
    expect(JSON.parse(placed.stdout)).toMatchObject({ outcome: "applied" });
    expect(JSON.parse(placed.stdout).version).toBeGreaterThan(result.version);

    const after = await read("mine/map", "--draft");
    const login = after.frames.find((f) => f.source.frame === "login");
    expect(login?.placement).toBe("placed");
    const mock = after.objects.find((o) => o.object.id === login?.object)?.object;
    expect(mock?.kind).toBe("rendered_frame");
    // Beside the sketch, below it with the gap, and not on top of it.
    const near = sketch?.object.pose as { x: number; y: number; w: number; h: number };
    expect(mock?.pose.y).toBeGreaterThanOrEqual(near.y + near.h + 60);

    // A frame that was never published says so, and sends nothing.
    const missing = await cli(
      ["board", "place-frame", "mine/map", "--frame", "nope", "--near", sketch?.object.id as string],
      agent(),
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Run artifacts publish first");
  }, 240_000);

  test("save, read the version back, and export it with the frames and the outline", async () => {
    const draft = await read("mine/map", "--draft");
    const saved = await cli(
      ["board", "save", "mine/map", "--name", "Ready", "-m", "Sketch and mocks", "--json"],
      agent(),
    );
    expect(saved.code).toBe(0);
    const version = JSON.parse(saved.stdout);
    expect(version.pictures).toBe("pending");
    const checkpoint = await read("mine/map", "--version", String(version.version));
    expect(checkpoint.draft).toBe(false);
    expect(checkpoint.objects.length).toBe(draft.objects.length);

    const dir = join(work, "export");
    const exported = await cli(
      ["board", "export", "mine/map", dir, "--version", String(version.version), "--json"],
      agent(),
    );
    expect(exported.code).toBe(0);
    const summary = JSON.parse(exported.stdout);
    expect(summary).toMatchObject({ version: version.version, objects: draft.objects.length });
    const scene = JSON.parse(readFileSync(join(dir, "board.json"), "utf8"));
    expect(scene.schema).toBe(1);
    expect(scene.objects.some((o: { kind: string }) => o.kind === "rendered_frame")).toBe(true);
    expect(readFileSync(join(dir, "outline.txt"), "utf8")).toContain("Pay with card");
    expect(existsSync(join(dir, "frames")) ? readdirSync(join(dir, "frames")).length : 0).toBeGreaterThan(0);

    // Nothing new to save the second time.
    expect((await cli(["board", "save", "mine/map"], agent())).stdout).toContain("Nothing new to save");
  }, 120_000);

  test("on a shared wiki an edit becomes a suggestion: exit 2, listed, previewed, and not on the board", async () => {
    const empty = await read("shared/map", "--draft");
    expect(empty.agents.edits).toBe("suggestion");
    const ops = file("shared.json", {
      epoch: empty.epoch,
      ops: [{ op: "add", ref: "$idea", object: sticky("An idea", 0, 0) }],
    });
    const done = await cli(["board", "edit", "shared/map", "--ops", ops, "--json"], agent());
    expect(done.code).toBe(2);
    const result = JSON.parse(done.stdout);
    expect(result.outcome).toBe("suggested");
    expect((await read("shared/map", "--draft")).objects).toEqual([]);

    const list = await cliJson(["board", "suggestions", "shared/map"], agent());
    const { untrusted: _, ...whole } = list;
    expect(BoardSuggestionList.parse(whole).suggestions.map((s) => s.id)).toContain(result.suggestion);
    const preview = await cli(
      ["board", "suggestions", "shared/map", "--preview", result.suggestion],
      agent(),
    );
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain(result.ids.$idea);
    // A token has no way to accept it: only a person does.
    const forced = await cli(["board", "suggest", "shared/map", "--ops", ops], agent());
    expect(forced.code).toBe(2);
  }, 120_000);

  test("a picture is checked here, uploaded and committed, and then an op can place it", async () => {
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#369" } })
      .png()
      .toBuffer();
    const path = join(work, "logo.png");
    writeFileSync(path, png);
    const asset = await cliJson(["board", "asset", "add", "mine/map", path], agent());
    expect(asset).toMatchObject({ type: "image/png", width: 64, height: 48, bytes: png.length });
    // Uploading the same bytes again is fine.
    expect((await cli(["board", "asset", "add", "mine/map", path], agent())).code).toBe(0);
    const now = await read("mine/map", "--draft");
    const ops = file("image.json", {
      epoch: now.epoch,
      ops: [
        {
          op: "add",
          ref: "$logo",
          object: {
            kind: "image",
            asset: asset.hash,
            alt: "Logo",
            pose: { x: 0, y: 600, w: 64, h: 48, angle: 0 },
            parent: null,
            label: "",
            style,
          },
        },
      ],
    });
    const placed = await cli(["board", "edit", "mine/map", "--ops", ops], agent());
    expect(placed.code).toBe(0);
    expect((await read("mine/map", "--draft")).assets.map((a) => a.hash)).toContain(asset.hash);

    // An SVG and a made-up hash never reach the server.
    expect(
      (
        await cli(
          ["board", "asset", "add", "mine/map", file("x.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>")],
          agent(),
        )
      ).code,
    ).toBe(2);
  }, 60_000);

  test("an old CLI still reads a board's comments: the pin has no anchor, but the thread is there", async () => {
    const artifact = await artifactAt(t, token, "mine/map");
    const latest = await read("mine/map");
    const pinned = latest.objects.find((o) => o.object.kind === "sticky")?.object.id as string;
    const made = await t.api(`/api/artifacts/${artifact.id}/threads`, {
      method: "POST",
      bearer: token,
      headers: { "Artifacts-CLI": "test", "Artifacts-Features": "editing,boards" },
      json: {
        pageKey: "board",
        version: latest.version,
        anchor: { type: "object", object: pinned, u: 0.5, v: 0.5, checkpoint: latest.version },
        body: "Is this the right step?",
      },
    });
    expect(made.status).toBe(200);
    const threads = async (features: string) => {
      const response = await t.api(`/api/artifacts/${artifact.id}/threads`, {
        bearer: token,
        headers: { "Artifacts-CLI": "0.1.0", "Artifacts-Features": features },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as
        | { anchor: { type: string } | null; body?: string }[]
        | { threads: { anchor: { type: string } | null }[] };
      return Array.isArray(body) ? body : body.threads;
    };
    const old = await threads("editing");
    expect(old.length).toBe(1);
    expect(old[0]?.anchor).toBeNull();
    // This CLI says it knows boards, so it gets the pin.
    expect((await threads("editing,boards"))[0]?.anchor).toMatchObject({ type: "object", object: pinned });
  });
});
