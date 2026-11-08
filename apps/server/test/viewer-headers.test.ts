import { expect, test } from "bun:test";
import { Hono } from "hono";
import { viewerHeaders } from "../src/http/viewer.ts";
import { bucketOrigin } from "../src/s3.ts";
import { testEnv } from "./helpers.ts";

test.each([true, false])(
  "viewer permits the configured presigned upload origin, path style %p",
  async (pathStyle) => {
    const env = testEnv("postgres://unused", {
      S3_ENDPOINT: "http://internal-storage:8333",
      S3_PUBLIC_ENDPOINT: "https://uploads.example.org:9443",
      S3_BUCKET: "board-pictures",
      S3_FORCE_PATH_STYLE: String(pathStyle),
    });
    const app = new Hono();
    app.use(viewerHeaders(env, bucketOrigin(env.s3)));
    app.get("/", (c) => c.text("viewer"));
    const response = await app.request("https://viewer.test/", {
      headers: { Origin: "https://attacker.example", "X-Forwarded-Host": "attacker.example" },
    });
    const csp = response.headers.get("Content-Security-Policy");
    const connect = csp?.split("; ").find((directive) => directive.startsWith("connect-src"));
    expect(connect).toBe(
      `connect-src 'self' https://${pathStyle ? "" : "board-pictures."}uploads.example.org:9443`,
    );
    expect(csp).not.toContain("internal-storage");
    expect(csp).not.toContain("attacker.example");
    expect(csp).not.toContain("*");
  },
);

test.each([
  "https://uploads.example/path",
  "https://uploads.example/?connect-src=*",
  "https://uploads.example https://other.example",
  "javascript:alert(1)",
])("upload endpoint configuration rejects %p", (endpoint) => {
  expect(() => testEnv("postgres://unused", { S3_PUBLIC_ENDPOINT: endpoint })).toThrow();
});
