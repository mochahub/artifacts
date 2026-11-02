import { existsSync } from "node:fs";
import { join } from "node:path";
import { home } from "../config.ts";
import { CliError, type Output } from "../output.ts";
import { confirm } from "../prompt.ts";

const SOURCE = "https://github.com/benjitaylor/skills";
// What references/stageshow.md was tested with. Move these only after testing the new ones.
const INSTALLER = "skills@1.7.4";
const COMMIT = "802057409787133703c56001080169e347305572";

const COMMAND = [
  "npx",
  "--yes",
  INSTALLER,
  "add",
  `benjitaylor/skills#${COMMIT}`,
  "--skill",
  "stageshow",
  "--global",
  "--agent",
  "claude-code",
  "codex",
  "--copy",
  "--yes",
];

const stageshowInstalled = () =>
  [".claude/skills/stageshow", ".agents/skills/stageshow"].some((dir) =>
    existsSync(join(home(), dir, "SKILL.md")),
  );

/** Says whether it worked, so setup can carry on and `skill install` can fail. */
async function run(out: Output) {
  out.say(`Installing Stageshow, a third-party skill from ${SOURCE}`);
  if (!Bun.which("npx")) {
    out.warn(`Stageshow needs Node.js for npx. Once you have it, run: ${COMMAND.join(" ")}`);
    return false;
  }
  const child = Bun.spawn(COMMAND, {
    cwd: home(),
    env: { ...process.env, DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" },
    stdin: "ignore",
    // Its progress goes to stderr, so `--json` keeps stdout to itself.
    stdout: 2,
    stderr: 2,
  });
  if ((await child.exited) === 0) return true;
  out.warn(`Stageshow didn't install. To try again, run: ${COMMAND.join(" ")}`);
  return false;
}

export async function installStageshow(out: Output) {
  if (!(await run(out))) throw new CliError("Stageshow didn't install.");
}

/** The one place anyone is asked: a skill that isn't ours is off until a person says yes. */
export async function offerStageshow(yes: boolean | undefined, out: Output) {
  if (stageshowInstalled()) return;
  if (!yes) {
    out.say("");
    out.say("Stageshow helps agents make polished product demos, feature cards and cursor walkthroughs.");
    out.say("It's third party: Benji Taylor makes it, and it isn't part of Artifacts or maintained by us.");
    out.say("It would run with your agent's permissions, and it needs React and a bundler to build scenes.");
    out.say(`Source: ${SOURCE}`);
    if (!(await confirm("Install Stageshow?", false).catch(() => false))) return;
  }
  await run(out);
}
