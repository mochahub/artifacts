import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, sandbox } from "./sandbox.ts";

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
  mkdirSync(bin, { recursive: true });
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$1" >> ${log}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { bin, opened: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

describe("login opens the browser", () => {
  const servers: ReturnType<typeof serverWithVerificationUrl>[] = [];
  afterAll(() => {
    for (const server of servers) server.stop(true);
  });

  async function loginTo(verificationUrl: string) {
    const server = serverWithVerificationUrl(verificationUrl);
    servers.push(server);
    const box = sandbox();
    const openers = fakeOpeners(box.home);
    const { ARTIFACTS_NO_BROWSER: _off, ...env } = box.env;
    await cli(["login", `http://127.0.0.1:${server.port}`], { ...env, PATH: `${openers.bin}:${env.PATH}` });
    // The opener is started and left running, so give it a moment to write its line.
    await Bun.sleep(300);
    return openers.opened();
  }

  test("for a web page", async () => {
    expect(await loginTo("https://art.example.com/device")).toEqual(["https://art.example.com/device"]);
  });

  test("but not for a file or an app the server named", async () => {
    expect(await loginTo("file:///System/Applications/Calculator.app")).toEqual([]);
    expect(await loginTo("/System/Applications/Calculator.app")).toEqual([]);
    expect(await loginTo("ssh://attacker.example/")).toEqual([]);
  });
});
