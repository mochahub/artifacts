import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  type SandboxedExtractor,
  validateSource,
} from "../../../apps/server/src/librarian/ingestion/extractor.ts";

export const liveContainers = new Set<string>();

/** Trusted host construction only. Requires a locally installed immutable image; never pulls or falls back. */
export function launch(image: string, signal: AbortSignal, scope = "v1"): SandboxedExtractor {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("extractor_image_required");
  return async ({ bytes, mime }) => {
    validateSource(bytes, mime);
    const name = `librarian-extract-${crypto.randomUUID()}`;
    const args = [
      "run",
      "--rm",
      "--pull=never",
      "--name",
      name,
      `--label=artifacts.private-executor=${scope}`,
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--memory=256m",
      "--memory-swap=256m",
      "--cpus=1",
      "--pids-limit=16",
      "--ulimit=cpu=10:10",
      "--ulimit=fsize=1048576:1048576",
      "--ulimit=nofile=64:64",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
      "--user=65534:65534",
      "-i",
      image,
      mime,
    ];
    return new Promise<string>((resolve, reject) => {
      liveContainers.add(name);
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let length = 0,
        failed = false;
      const fail = () => {
        if (failed) return;
        failed = true;
        // Killing the client alone does not stop the container. Force removal and reap the client.
        const cleanup = spawn("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 5000 });
        cleanup.on("error", () => {});
        child.kill("SIGKILL");
      };
      const timer = setTimeout(fail, 15000);
      signal.addEventListener("abort", fail, { once: true });
      if (signal.aborted) fail();
      child.on("error", () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", fail);
        liveContainers.delete(name);
        reject(new Error("extractor_unavailable"));
      });
      child.stdin.on("error", fail);
      child.stdout.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 1048576) fail();
        else chunks.push(chunk);
      });
      child.on("close", async (code) => {
        liveContainers.delete(name);
        clearTimeout(timer);
        signal.removeEventListener("abort", fail);
        if (failed || code !== 0) {
          // Repeat after client exit to close a create-vs-timeout race; wait for cleanup to exit.
          await new Promise<void>((done) => {
            const cleanup = spawn("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 5000 });
            cleanup.once("error", () => done());
            cleanup.once("close", () => done());
          });
          try {
            const { stdout } = await promisify(execFile)(
              "docker",
              ["ps", "-aq", "--filter", `name=^/${name}$`],
              { timeout: 5000 },
            );
            if (stdout.trim()) throw new Error("orphan");
          } catch {
            return reject(new Error("executor_cleanup_failed"));
          }
          return reject(new Error("extraction_rejected"));
        }
        try {
          resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        } catch {
          reject(new Error("extraction_rejected"));
        }
      });
      child.stdin.end(bytes);
    });
  };
}
