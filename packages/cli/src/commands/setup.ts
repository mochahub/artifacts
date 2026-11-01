import qrcode from "qrcode-terminal";
import { setupDocker } from "../docker/setup.ts";
import type { Output } from "../output.ts";
import { ask, confirm } from "../prompt.ts";
import { setupRailway } from "../railway/setup.ts";
import { installSkill } from "../skill/install.ts";
import { type ClaimAnswers, setupExisting } from "./account.ts";
import { BRAND_PROMPT } from "./brand.ts";

type Flags = ClaimAnswers & {
  docker?: boolean;
  dir?: string;
  image?: string;
  port?: number;
  setupToken?: string;
  skill?: boolean;
};

export async function setup(url: string | undefined, flags: Flags, out: Output) {
  let person: { name: string; email: string };
  let target: string | null = url ?? null;
  if (flags.docker) {
    const result = await setupDocker(flags, out);
    person = result.person;
    target = result.url;
  } else if (url) {
    person = await setupExisting(url, flags, out);
  } else {
    const choice = await ask("Where should your Artifacts server run? [railway/docker/existing]");
    if (choice === "docker") {
      const result = await setupDocker(flags, out);
      person = result.person;
      target = result.url;
    } else if (choice === "existing") {
      target = await ask("Server URL:");
      person = await setupExisting(target, flags, out);
    } else {
      const result = await setupRailway(flags, out);
      person = result.person;
      target = result.url;
    }
  }
  if (
    flags.skill !== false &&
    (await confirm("Install the skill for Claude Code and Codex?").catch(() => false))
  ) {
    installSkill({}, out);
  }
  out.result({ server: target, person }, () => {
    out.say(`Signed in as ${person.name}.`);
    out.say("  Add a passkey     scan with your phone, or open the link:");
    if (process.stdout.isTTY)
      qrcode.generate(`${target}/settings/sign-in`, { small: true }, (code) => out.say(code));
    out.say(`                    ${target}/settings/sign-in`);
    out.say("  Invite someone    artifacts org invite sam@example.com");
    out.say("  Your own domain   artifacts domain add art.example.com");
    out.say("");
    out.say("Artifacts has a good default look. To fit your brand, hand this to your agent:");
    out.say("");
    out.say(BRAND_PROMPT);
  });
}
