import { setupDocker } from "../docker/setup.ts";
import { CliError, type Output } from "../output.ts";
import { ask } from "../prompt.ts";
import { type ClaimAnswers, setupExisting } from "./account.ts";

type Flags = ClaimAnswers & {
  docker?: boolean;
  dir?: string;
  image?: string;
  port?: number;
  setupToken?: string;
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
      throw new CliError("Railway setup isn't available in this build yet. Use --docker or a URL.");
    }
  }
  out.result({ server: target, person }, () => out.say(`Signed in as ${person.name}.`));
}
