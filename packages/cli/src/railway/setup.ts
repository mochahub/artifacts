import { Meta } from "@artifacts/schema";
import { Client } from "../client.ts";
import { type ClaimAnswers, claim } from "../commands/account.ts";
import { saveServer } from "../config.ts";
import { CliError, type Output } from "../output.ts";
import { ask } from "../prompt.ts";
import {
  domainsByPort,
  hasRailway,
  isDeployed,
  railway,
  railwayDir,
  railwayJson,
  SERVICE,
  signedInToRailway,
  variables,
} from "./cli.ts";

const VIEWER_PORT = 8080;
const CONTENT_PORT = 8081;
const TIMEOUT_MS = 10 * 60_000;
const POLL_MS = () => Number(process.env.ARTIFACTS_RAILWAY_POLL_MS ?? 5000);

const TEMPLATE = "yaznvG";
/** Railway drops plain values from a generated template and then asks for them, which needs a terminal. */
const TEMPLATE_VALUES = [
  `${SERVICE}.S3_FORCE_PATH_STYLE=false`,
  "Postgres.PGDATA=/var/lib/postgresql/data/pgdata",
  "Postgres.PGPORT=5432",
  "Postgres.POSTGRES_DB=railway",
  "Postgres.POSTGRES_USER=postgres",
  "Postgres.RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60",
  "Postgres.SSL_CERT_DAYS=820",
];

const until = async (what: string, check: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      if (await check()) return;
    } catch {}
    if (Date.now() > deadline) throw new CliError(`Timed out waiting for ${what}.`);
    await Bun.sleep(POLL_MS());
  }
};

/** The Railway path in 07. Every step drives the Railway CLI. */
export async function setupRailway(flags: ClaimAnswers & { projectName?: string }, out: Output) {
  const template = process.env.ARTIFACTS_RAILWAY_TEMPLATE || TEMPLATE;
  if (!hasRailway()) {
    throw new CliError(
      "The Railway CLI isn't installed. Run: brew install railway (or npm i -g @railway/cli)",
    );
  }
  const name = flags.projectName ?? "artifacts";
  const dir = railwayDir(name);

  let who = signedInToRailway(dir);
  if (!who) {
    Bun.spawnSync(["railway", "login"], { cwd: dir, stdio: ["inherit", "inherit", "inherit"] });
    who = signedInToRailway(dir);
    if (!who) throw new CliError("Railway sign-in didn't finish.");
  }
  out.say(`✓ Railway CLI, signed in as ${who.email ?? who.name}`);

  const workspaces = who.workspaces ?? [];
  let workspace = workspaces[0];
  if (workspaces.length > 1) {
    const chosen = await ask(`Railway workspace [${workspaces.map((w) => w.name).join(" / ")}]:`);
    workspace = workspaces.find((w) => w.name === chosen);
    if (!workspace) throw new CliError(`There's no workspace "${chosen}".`);
  }

  const init = ["init", "--name", name, ...(workspace ? ["--workspace", workspace.id] : [])];
  const project = railwayJson<{ id?: string; projectId?: string }>(init, dir);
  const projectId = project.id ?? project.projectId ?? "";
  out.say(`✓ Created Railway project "${name}"`);
  try {
    railway(["deploy", "--template", template, ...TEMPLATE_VALUES.flatMap((v) => ["--variable", v])], dir);
  } catch (error) {
    // Nothing is in it yet, and a project left behind would only be billed for and confuse the next try.
    try {
      railway(["delete", "--project", projectId, "--yes"], dir);
    } catch {
      out.warn(`Railway project "${name}" is empty. Delete it in the Railway dashboard.`);
    }
    throw error;
  }
  out.say("✓ Deployed the Artifacts template: app, Postgres, storage bucket");

  await until("the deploy", () => isDeployed(dir));
  const domains = domainsByPort(dir);
  const viewer = domains.get(VIEWER_PORT);
  const content = domains.get(CONTENT_PORT);
  if (!viewer || !content) throw new CliError("The template didn't create the viewer and content domains.");
  const url = `${process.env.ARTIFACTS_RAILWAY_HTTP ? "http" : "https"}://${viewer}`;

  // Railway has no variable for the second domain, so setup writes it (spike S1).
  railway(["variable", "set", `CONTENT_URL=https://${content}`, "--service", SERVICE], dir);
  // Until it reports the new value, what answers may still be the deploy before this one.
  await until("the server to come back", async () => {
    const meta = Meta.parse(await new Client(url).get("/api/meta"));
    return meta.contentUrl === `https://${content}` && isDeployed(dir);
  });
  out.say(`✓ Running: ${url}   (home domain for passkeys)`);

  const token = variables(dir).SETUP_TOKEN;
  if (!token) {
    throw new CliError("Couldn't read SETUP_TOKEN. If it's sealed, paste it: artifacts setup <url>");
  }
  const person = await claim(url, token, flags, out);
  saveServer({
    url,
    name,
    railway: { projectId, service: SERVICE },
  });
  return { url, person };
}
