import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, fakeBin, sandbox } from "./sandbox.ts";

/** A server whose sign-in page is wherever the test says. */
function serverWithVerificationUrl(verificationUrl: string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/device/start") {
        return Response.json({
          deviceCode: "d",
          userCode: "ABCD-EFGH",
          verificationUrl,
          interval: 0,
          expiresIn: 5,
        });
      }
      return Response.json({ status: "denied" });
    },
  });
}

/** `open` and `xdg-open` that only write down what they were asked to open. */
function fakeOpeners(home: string) {
  const bin = join(home, "openers");
  const log = join(home, "opened.log");
  for (const name of ["open", "xdg-open"]) fakeBin(bin, name, `echo "$1" >> ${log}`);
  return { bin, opened: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

describe("login opens the browser", () => {
  const servers: ReturnType<typeof serverWithVerificationUrl>[] = [];
  afterAll(() => {
    for (const server of servers) server.stop(true);
  });

  /** Logs in to a server that names `verificationUrl`, with openers that write down what they open. */
  async function loginTo(openers: ReturnType<typeof fakeOpeners>, env: Record<string, string>, url: string) {
    const server = serverWithVerificationUrl(url);
    servers.push(server);
    await cli(["login", `http://127.0.0.1:${server.port}`], { ...env, PATH: `${openers.bin}:${env.PATH}` });
  }
  /** The opener is started and left running, so wait for the line it writes. */
  async function opened(openers: ReturnType<typeof fakeOpeners>) {
    for (let i = 0; i < 200 && openers.opened().length === 0; i++) await Bun.sleep(25);
    return openers.opened();
  }
  const browserBox = () => {
    const box = sandbox();
    const { ARTIFACTS_NO_BROWSER: _off, ...env } = box.env;
    return { openers: fakeOpeners(box.home), env };
  };

  test("for a web page", async () => {
    const { openers, env } = browserBox();
    await loginTo(openers, env, "https://art.example.com/device");
    expect(await opened(openers)).toEqual(["https://art.example.com/device"]);
  });

  test("but not for a file or an app the server named", async () => {
    const { openers, env } = browserBox();
    for (const url of [
      "file:///System/Applications/Calculator.app",
      "/System/Applications/Calculator.app",
      "ssh://attacker.example/",
    ]) {
      await loginTo(openers, env, url);
    }
    // A web page last: once its line is written, an opener started for any earlier one would have written too.
    await loginTo(openers, env, "https://art.example.com/after");
    expect(await opened(openers)).toEqual(["https://art.example.com/after"]);
  });
});
