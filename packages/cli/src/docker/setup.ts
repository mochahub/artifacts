import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import compose from "../../../../deploy/compose/docker-compose.yml" with { type: "text" };
import { type ClaimAnswers, claim, health } from "../commands/account.ts";
import { saveServer } from "../config.ts";
import { CliError, type Output } from "../output.ts";
import { VERSION } from "../version.ts";

const secret = (bytes: number) => randomBytes(bytes).toString("hex");
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

export const defaultImage = () => process.env.ARTIFACTS_IMAGE ?? `ghcr.io/mochahub/artifacts:${VERSION}`;

function run(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, { cwd, stdout: "ignore", stderr: "pipe" });
  if (!result.success) throw new CliError(`${command.join(" ")} failed:\n${result.stderr.toString()}`);
}

/** Writes docker-compose.yml, .env and s3.json. Never overwrites an existing deployment's secrets. */
export function writeDeployment(dir: string, image: string, port: number) {
  if (existsSync(join(dir, ".env"))) {
    throw new CliError(`${dir} already has a deployment. Pick another folder with --dir.`);
  }
  // The image is written into .env as KEY=value, so a newline in it (--image, or ARTIFACTS_IMAGE) would add a variable.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(image)) {
    throw new CliError(`"${image}" isn't an image name like ghcr.io/mochahub/artifacts:0.2.0.`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const accessKey = secret(16);
  const secretKey = secret(32);
  const setupToken = secret(24);
  const s3Port = port + 253; // 8080 becomes 8333, weed's usual port.
  const env = {
    ARTIFACTS_IMAGE: image,
    VIEWER_PORT: port,
    LIVE_PORT: port + 1,
    S3_PORT: s3Port,
    PUBLIC_URL: `http://localhost:${port}`,
    CONTENT_URL: `http://127.0.0.1:${port + 1}`,
    S3_PUBLIC_ENDPOINT: `http://127.0.0.1:${s3Port}`,
    POSTGRES_PASSWORD: secret(24),
    S3_ACCESS_KEY_ID: accessKey,
    S3_SECRET_ACCESS_KEY: secretKey,
    SETUP_TOKEN: setupToken,
    SESSION_SECRET: secret(32),
    OPS_SECRET: secret(32),
  };
  writeFileSync(join(dir, "docker-compose.yml"), compose);
  writeFileSync(
    join(dir, ".env"),
    `${Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(dir, "s3.json"),
    JSON.stringify({
      identities: [
        {
          name: "artifacts",
          credentials: [{ accessKey, secretKey }],
          actions: ["Admin", "Read", "List", "Tagging", "Write"],
        },
      ],
    }),
    { mode: 0o644 },
  );
  return { url: env.PUBLIC_URL, setupToken };
}

export async function setupDocker(
  flags: ClaimAnswers & { dir?: string; image?: string; port?: number },
  out: Output,
) {
  const dir = resolve(flags.dir ?? "artifacts-server");
  const { url, setupToken } = writeDeployment(dir, flags.image ?? defaultImage(), flags.port ?? 8080);
  out.say(`Wrote docker-compose.yml and .env to ${dir}`);
  run(["docker", "compose", "up", "-d"], dir);
  out.say("Starting the app, Postgres and SeaweedFS…");

  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      if ((await health(url)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new CliError(`${url} didn't become healthy. See: docker compose logs`);
    await wait(1000);
  }
  out.say(`Running: ${url}`);
  const person = await claim(url, setupToken, flags, out);
  saveServer({ url, name: "docker", docker: { dir } });
  return { url, person };
}
