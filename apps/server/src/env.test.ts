import { describe, expect, test } from "bun:test";
import { EnvError, parseEnv } from "./env.ts";

const valid = {
  DATABASE_URL: "postgres://localhost/artifacts",
  S3_ENDPOINT: "http://seaweedfs:8333",
  S3_REGION: "auto",
  S3_BUCKET: "artifacts",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  PUBLIC_URL: "https://artifacts-production.up.railway.app",
  CONTENT_URL: "https://artifacts-content-production.up.railway.app",
  SETUP_TOKEN: "s".repeat(48),
  SESSION_SECRET: "s".repeat(64),
  OPS_SECRET: "o".repeat(64),
};

describe("parseEnv", () => {
  test("applies the defaults in 09", () => {
    const { env, warnings } = parseEnv(valid);
    expect(env.port).toBe(8080);
    expect(env.contentPort).toBe(8081);
    expect(env.internalPort).toBe(8082);
    expect(env.logLevel).toBe("info");
    expect(env.s3.forcePathStyle).toBe(true);
    expect(env.s3.publicEndpoint).toBe("http://seaweedfs:8333");
    expect(warnings).toEqual([]);
  });

  test("lists every problem at once", () => {
    const { DATABASE_URL: _, SETUP_TOKEN: __, ...rest } = valid;
    expect(() => parseEnv(rest)).toThrow(EnvError);
    expect(() => parseEnv(rest)).toThrow(/DATABASE_URL[\s\S]*SETUP_TOKEN/);
  });

  test.each(["not a url", "ftp://x.example", "https://x.example/path", "https://x.example/?a=1"])(
    "refuses PUBLIC_URL %p",
    (url) => {
      expect(() => parseEnv({ ...valid, PUBLIC_URL: url })).toThrow(EnvError);
    },
  );

  test("refuses a short secret", () => {
    expect(() => parseEnv({ ...valid, OPS_SECRET: "short" })).toThrow(/OPS_SECRET/);
  });

  test("runs without CONTENT_URL, and treats empty variables as unset", () => {
    expect(parseEnv({ ...valid, CONTENT_URL: "", MORE_URLS: "" }).env.contentUrl).toBeNull();
  });

  test("collects viewer origins without a duplicate", () => {
    const { env } = parseEnv({ ...valid, MORE_URLS: `https://art.zahin.ca, ${valid.PUBLIC_URL}` });
    expect(env.viewerOrigins).toEqual([valid.PUBLIC_URL, "https://art.zahin.ca"]);
  });

  test("refuses a bad entry in MORE_URLS", () => {
    expect(() => parseEnv({ ...valid, MORE_URLS: "art.zahin.ca" })).toThrow(/MORE_URLS/);
  });

  test("refuses a content host that's also a viewer host", () => {
    expect(() => parseEnv({ ...valid, CONTENT_URL: valid.PUBLIC_URL })).toThrow(/CONTENT_URL/);
    expect(() => parseEnv({ ...valid, MORE_URLS: valid.CONTENT_URL })).toThrow(/CONTENT_URL/);
  });

  test("refuses the same hostname on another port, which is the same site", () => {
    const local = { ...valid, PUBLIC_URL: "http://localhost:8080", CONTENT_URL: "http://localhost:8081" };
    expect(() => parseEnv(local)).toThrow(/CONTENT_URL/);
  });

  test("warns when content and viewer share a registrable domain", () => {
    const { warnings } = parseEnv({
      ...valid,
      PUBLIC_URL: "https://art.zahin.ca",
      CONTENT_URL: "https://content.zahin.ca",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("same site");
  });

  test("doesn't warn for two generated Railway domains: up.railway.app is a public suffix", () => {
    expect(parseEnv(valid).warnings).toEqual([]);
  });
});
