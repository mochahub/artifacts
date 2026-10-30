import { afterAll, describe, expect, test } from "bun:test";
import { cli, sandbox } from "./sandbox.ts";

/** A server that only writes down who called it, and with what. */
function recorder() {
  const seen: { path: string; authorization: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      seen.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
      return Response.json({ error: { code: "unauthenticated", message: "No.", details: {} } }, { status: 401 });
    },
  });
  return { seen, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe("a token goes only to the server it is for", () => {
  const home = recorder();
  const other = recorder();
  afterAll(() => {
    home.stop();
    other.stop();
  });

  test("ARTIFACTS_TOKEN is not sent to another server named with --server", async () => {
    const box = sandbox();
    const env = { ...box.env, ARTIFACTS_URL: home.url, ARTIFACTS_TOKEN: "art_secret" };

    const here = await cli(["whoami", "--json"], env);
    expect(here.code).toBe(1);
    expect(home.seen.at(-1)?.authorization).toBe("Bearer art_secret");

    const there = await cli(["whoami", "--server", other.url], env);
    expect(there.code).toBe(1);
    expect(there.stderr).toContain("Not signed in");
    expect(other.seen).toEqual([]);
  });

  test("with no ARTIFACTS_URL, it belongs to the default server in config", async () => {
    const box = sandbox();
    const env = { ...box.env, ARTIFACTS_TOKEN: "art_secret" };
    await Bun.write(
      `${box.env.XDG_CONFIG_HOME}/artifacts/config.json`,
      JSON.stringify({ servers: [{ url: home.url, name: "home", default: true }] }),
    );

    await cli(["whoami"], env);
    expect(home.seen.at(-1)?.authorization).toBe("Bearer art_secret");

    await cli(["whoami", "--server", other.url], env);
    expect(other.seen).toEqual([]);
  });

  test("with no server known at all, --server is the only way to name one, so it gets the token", async () => {
    const box = sandbox();
    await cli(["whoami", "--server", other.url], { ...box.env, ARTIFACTS_TOKEN: "art_secret" });
    expect(other.seen.at(-1)?.authorization).toBe("Bearer art_secret");
  });
});
