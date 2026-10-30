import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { artifactRef } from "../src/commands/review.ts";
import { capOutput } from "../src/commands/mcp.ts";
import { saveServer } from "../src/config.ts";
import { UsageError } from "../src/output.ts";
import { cli, sandbox } from "./sandbox.ts";

// Every one of these stops before a request is made, so none needs a server.
describe("arguments that end up in a URL or a port", () => {
  test("a port is a number with room above it", async () => {
    const box = sandbox();
    for (const port of ["abc", "0", "70000", "1.5"]) {
      const dev = await cli(["dev", "--port", port], box.env);
      expect(dev.code).toBe(2);
      expect(dev.stderr).toContain("--port wants a number");
      expect((await cli(["setup", "--docker", "--port", port], box.env)).code).toBe(2);
    }
  });

  test("an artifact is project/slug in the characters slugs use", () => {
    expect(artifactRef("demo/small")).toEqual({ project: "demo", slug: "small" });
    for (const bad of ["../x", "demo/..", "a/b/c", "Demo/small", "demo/sm all"]) {
      expect(() => artifactRef(bad)).toThrow(UsageError);
    }
  });

  test("versions and data keys can't carry a path or a second parameter", async () => {
    const box = sandbox();
    for (const args of [
      ["delete", "--version", "1/../2"],
      ["undelete", "--version", "x"],
      ["logs", "--version", "1&after=0"],
      ["diff", "1", "2/3"],
      ["versions", "name", "1&x=2", "label"],
      ["data", "get", "../../logs"],
    ]) {
      const result = await cli(args, box.env);
      expect(result.code).toBe(2);
    }
  });

  test("init does not take an object's own name for a kind", async () => {
    const box = sandbox();
    const result = await cli(["init", "--kind", "constructor"], box.env, box.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--kind is canvas");
  });
});

describe("the server list", () => {
  test("signing in again keeps the name, which the Railway folder is named after", () => {
    const box = sandbox();
    process.env.XDG_CONFIG_HOME = box.env.XDG_CONFIG_HOME;
    try {
      const railway = { projectId: "p", service: "artifacts" };
      saveServer({ url: "https://art.example.com", name: "artifacts", railway });
      saveServer({ url: "https://art.example.com", name: "art.example.com" });
      const [server] = JSON.parse(readFileSync(join(box.env.XDG_CONFIG_HOME as string, "artifacts/config.json"), "utf8")).servers;
      expect(server).toMatchObject({ name: "artifacts", railway, default: true });
    } finally {
      delete process.env.XDG_CONFIG_HOME;
    }
  });
});

describe("MCP answers", () => {
  test("are cut off before they fill a model's context", () => {
    expect(capOutput("short")).toBe("short");
    const cut = capOutput("x".repeat(250_000));
    expect(cut.length).toBeLessThan(101_000);
    expect(cut).toContain("150000 more characters");
  });
});
