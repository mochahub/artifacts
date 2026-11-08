import { spawn } from "node:child_process";
import { type SandboxedExtractor, validateSource } from "./extractor.ts";

/** Trusted host construction only. Requires a locally installed immutable image; never pulls or falls back. */
export function containerExtractor(image: string): SandboxedExtractor {
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
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Error("extractor_unavailable"));
      });
      child.stdin.on("error", fail);
      child.stdout.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 1048576) fail();
        else chunks.push(chunk);
      });
      child.on("close", async (code) => {
        clearTimeout(timer);
        if (failed || code !== 0) {
          // Repeat after client exit to close a create-vs-timeout race; wait for cleanup to exit.
          await new Promise<void>((done) => {
            const cleanup = spawn("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 5000 });
            cleanup.once("error", () => done());
            cleanup.once("close", () => done());
          });
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
