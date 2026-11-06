import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asBun } from "../src/bun.ts";
import { cli, copyFixture, fixture, sandbox } from "./sandbox.ts";

describe("the render helper", () => {
  test("is not given the sign-in token", () => {
    process.env.ARTIFACTS_TOKEN = "art_secret";
    try {
      const seen = asBun(["-e", "console.log(process.env.ARTIFACTS_TOKEN ?? 'none')"], tmpdir());
      expect(seen.stdout.toString().trim()).toBe("none");
    } finally {
      delete process.env.ARTIFACTS_TOKEN;
    }
  });

  test("serves the bundle and nothing beside or behind it", async () => {
    const box = sandbox();
    const dir = copyFixture(fixture("small"));
    // A sibling folder whose name starts like the bundle's, and a link out of the bundle.
    mkdirSync(`${dir}-x`);
    writeFileSync(`${dir}-x/secret.txt`, "sibling");
    writeFileSync(join(box.home, "outside.txt"), "outside");
    symlinkSync(join(box.home, "outside.txt"), join(dir, "link.txt"));
    writeFileSync(join(dir, "inside.txt"), "inside");
    const name = dir.split("/").at(-1);
    // The page's own script asks, as a hostile artifact's would. Nothing here names a file the crawl could see.
    writeFileSync(
      join(dir, "boards/main.html"),
      `<div data-frame="one" data-device="none" class="box"><p>One</p></div>
<script>
for (const path of ["/..%2F${name}-x%2Fsecret.txt", "/link.txt", "/inside.txt"]) {
  document.body.insertAdjacentHTML("beforeend", '<img width="1" height="1" src="' + path + '">');
}
</script>`,
    );
    const result = await cli(["render", "--json"], box.env, dir);
    expect(result.code).toBe(0);
    const failed = (JSON.parse(result.stdout).problems as { message: string }[])
      .map((p) => p.message)
      .join("\n");
    expect(failed).toContain("secret.txt");
    expect(failed).toContain("link.txt");
    expect(failed).not.toContain("inside.txt");
  }, 120_000);

  test("runs a backend as the server does: with the query string, and env.DATA on the fixtures", async () => {
    const box = sandbox();
    const dir = copyFixture(fixture("small"));
    const manifest = JSON.parse(readFileSync(join(dir, "artifact.json"), "utf8"));
    writeFileSync(
      join(dir, "artifact.json"),
      JSON.stringify({ ...manifest, backend: { src: "api/index.js" }, pages: [manifest.pages[1]] }),
    );
    mkdirSync(join(dir, "api"));
    writeFileSync(
      join(dir, "api/index.js"),
      `export default { async fetch(request, env) {
        const x = new URL(request.url).searchParams.get("x");
        const { keys } = await env.DATA.list();
        return new Response(x + "-" + (await env.DATA.get("votes")) + "-" + keys.join(","));
      } };`,
    );
    mkdirSync(join(dir, "fixtures"));
    writeFileSync(join(dir, "fixtures/data.json"), JSON.stringify({ shared: { votes: "three" } }));
    // The frame's title is its heading, which the page fills from the backend while it loads.
    writeFileSync(
      join(dir, "boards/main.html"),
      `<div data-frame="one" data-device="none" class="box"><h1 id="answer">?</h1></div>
<script>
const asked = new XMLHttpRequest();
asked.open("GET", "../api/answer?x=yes", false);
asked.send();
document.getElementById("answer").textContent = asked.responseText;
</script>`,
    );
    const packed = await cli(["pack", "--json"], box.env, dir);
    expect(packed.code).toBe(0);
    const { payload } = JSON.parse(packed.stdout) as { payload: { sha256: string } };
    const commit = JSON.parse(readFileSync(join(dir, ".artifacts/pack/files", payload.sha256), "utf8"));
    expect(commit.frames[0].title).toBe("yes-three-votes");
  }, 120_000);
});
