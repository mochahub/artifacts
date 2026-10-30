import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Publishes the CameraBuddy fixture twice with the real CLI, so v2 has changes to show. */
export function seedFixture(url: string, token: string) {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-e2e-"));
  const cli = join(import.meta.dirname, "../../../packages/cli/src/index.ts");
  cpSync(join(import.meta.dirname, "../../../fixtures/camerabuddy-roadmap"), dir, { recursive: true });
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    ARTIFACTS_URL: url,
    ARTIFACTS_TOKEN: token,
    ARTIFACTS_HELPER_DIR: join(tmpdir(), "artifacts-test-helper"),
    ARTIFACTS_AGENT: "Claude Code",
    PLAYWRIGHT_BROWSERS_PATH:
      process.env.PLAYWRIGHT_BROWSERS_PATH ??
      join(
        homedir(),
        process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright",
      ),
  };
  const publish = (message: string) =>
    execFileSync("bun", [cli, "publish", "-m", message, "--json"], { cwd: dir, env, stdio: "pipe" });
  publish("First draft");

  const board = join(dir, "boards/02-shoot.html");
  writeFileSync(board, readFileSync(board, "utf8").replace("../img/02-01.jpg", "../img/02-03.jpg"));
  const plan = join(dir, "README.md");
  writeFileSync(
    plan,
    readFileSync(plan, "utf8").replace("Ship pairing, live view", "Ship pairing, a faster live view"),
  );
  publish("Move MF above the strip");
}
