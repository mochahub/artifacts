import { describe, expect, test } from "bun:test";
import {
  BridgeRequest,
  BridgeResponse,
  DEFAULT_ORG_SETTINGS,
  EditComment,
  GuestName,
  Manifest,
  OrgSettings,
  Permission,
  PublishResult,
  Slug,
} from "./index.ts";
import { sanitizeArticle } from "./sanitize.ts";

const spec = {
  project: "camerabuddy",
  slug: "roadmap",
  visibility: "org",
  title: "Camera Buddy roadmap",
  theme: { accent: "#ff9f0a", font: "inter", mode: "auto" },
  backend: { src: "api/index.ts" },
  pages: [
    { id: "plan", kind: "article", src: "README.md" },
    { id: "research-01", kind: "article", src: "research/01-wifi.md", group: "Research" },
    {
      id: "mocks",
      kind: "canvas",
      boards: [{ id: "onboarding", title: "Onboarding", subtitle: "First run", src: "mocks/body-01.html" }],
      styles: ["mocks/mock.css"],
      scripts: ["mocks/img/photos.js", "mocks/mock.js"],
    },
  ],
};

describe("manifest", () => {
  test("accepts the example in SPEC §4.1", () => {
    expect(Manifest.parse(spec).pages).toHaveLength(3);
  });

  test("fills defaults", () => {
    const parsed = Manifest.parse({
      ...spec,
      theme: {},
      pages: [
        { id: "m", kind: "canvas", boards: [{ id: "b", title: "B", src: "b.html" }] },
        { id: "p", kind: "prototype", src: "index.html" },
      ],
    });
    expect(parsed.theme?.mode).toBe("auto");
    expect(parsed.pages[0]).toMatchObject({ styles: [], scripts: [] });
    expect(parsed.pages[1]).toMatchObject({ device: "iphone" });
  });

  test.each(["/etc/passwd", "../up.md", "a/../../b.md", "a\\..\\b.md", ""])("refuses the path %p", (src) => {
    expect(Manifest.safeParse({ ...spec, pages: [{ id: "p", kind: "article", src }] }).success).toBe(false);
  });

  test("needs a page", () => {
    expect(Manifest.safeParse({ ...spec, pages: [] }).success).toBe(false);
  });

  test("refuses reserved and malformed slugs", () => {
    for (const slug of ["api", "s", "settings", "sign-in", "Has-Caps", "a_b", "", "x".repeat(41)]) {
      expect(Slug.safeParse(slug).success).toBe(false);
    }
    expect(Slug.safeParse("roadmap-2").success).toBe(true);
  });
});

describe("bridge messages", () => {
  test("round trips every request kind", () => {
    const ops = [
      { kind: "get", scope: "shared", key: "votes" },
      { kind: "list", scope: "me", prefix: "todos/" },
      { kind: "put", scope: "shared", key: "votes", value: { a: 1 }, ifMatch: "*" },
      { kind: "delete", scope: "me", key: "x" },
      { kind: "file.put", scope: "me", name: "a.jpg", blob: new Blob(["x"]) },
      { kind: "file.url", scope: "me", name: "a.jpg" },
      { kind: "file.list", scope: "shared" },
      { kind: "file.delete", scope: "shared", name: "a.jpg" },
      { kind: "whoami" },
    ];
    for (const op of ops) expect(BridgeRequest.safeParse({ artifacts: 1, id: "1", op }).success).toBe(true);
  });

  test("refuses another protocol version and unknown ops", () => {
    expect(BridgeRequest.safeParse({ artifacts: 2, id: "1", op: { kind: "whoami" } }).success).toBe(false);
    expect(BridgeRequest.safeParse({ artifacts: 1, id: "1", op: { kind: "eval" } }).success).toBe(false);
  });

  test("error responses carry a known code", () => {
    const base = { artifacts: 1, id: "1", ok: false };
    expect(BridgeResponse.safeParse({ ...base, error: { code: "read_only", message: "x" } }).success).toBe(
      true,
    );
    expect(BridgeResponse.safeParse({ ...base, error: { code: "nope", message: "x" } }).success).toBe(false);
  });
});

describe("api", () => {
  test("default settings match their schema and the limits in 08", () => {
    const settings = OrgSettings.parse(DEFAULT_ORG_SETTINGS);
    expect(settings.limits.backendMemoryMb).toBe(64);
    expect(settings.limits.backendRequestsPerMinute).toBe(120);
    expect(settings.sandboxProcesses).toBe(2);
  });

  test("the permission enum has publish", () => {
    expect(Permission.options).toEqual(["view", "comment", "publish"]);
  });

  test("accepts the PublishResult example in 03", () => {
    const example = {
      version: 5,
      url: "https://art.zahin.ca/camerabuddy/roadmap",
      changes: {
        frames: { added: [], removed: [], changed: ["live-view"] },
        blocks: { changed: ["phase-1"] },
      },
      threadsOnChanged: [3, 4, 6, 8],
      orphaned: [],
      uploaded: { files: 7, bytes: 421888 },
      reused: 214,
    };
    expect(PublishResult.safeParse(example).success).toBe(true);
  });
});

describe("the article allowlist", () => {
  test("drops scripts, styles, event attributes and hostile URLs", () => {
    const clean = sanitizeArticle(`<p data-block="a" onclick="x()">Hi<script>alert(1)</script></p>
      <style>body{display:none}</style><iframe src="https://evil.test"></iframe>
      <a href="javascript:alert(1)">link</a><img src="https://evil.test/x.png"><img src="artifacts:blob/abc">
      <svg onload="x()" viewBox="0 0 1 1"><foreignObject><div>x</div></foreignObject><path d="M0 0" style="fill:url(https://evil.test)"/></svg>`);
    expect(clean).toContain('data-block="a"');
    expect(clean).toContain("artifacts:blob/abc");
    for (const bad of [
      "script",
      "style",
      "iframe",
      "onclick",
      "onload",
      "javascript:",
      "evil.test",
      "foreignObject",
    ]) {
      expect(clean.toLowerCase()).not.toContain(bad.toLowerCase());
    }
  });

  test("keeps SVG drawing and internal marker references, not external ones", () => {
    const clean = sanitizeArticle(
      '<svg viewBox="0 0 10 10"><path d="M0 0L1 1" fill="#fff" marker-end="url(#arrow)"/><path d="M0 0" marker-end="url(https://evil.test/#a)"/></svg>',
    );
    expect(clean).toContain('marker-end="url(#arrow)"');
    expect(clean).not.toContain("evil.test");
  });

  test("is stable: sanitizing twice changes nothing", () => {
    const once = sanitizeArticle(
      '<h2 id="a" data-block="a">T</h2><table><tr><td align="left">x</td></tr></table>',
    );
    expect(sanitizeArticle(once)).toBe(once);
  });
});

describe("names that routes would swallow", () => {
  test("refuses the word search as a project, and compare as a page", () => {
    expect(Slug.safeParse("search").success).toBe(false);
    const page = (id: string) => ({ ...spec, pages: [{ id, kind: "article", src: "a.md" }] });
    expect(Manifest.safeParse(page("compare")).success).toBe(false);
    expect(Manifest.safeParse(page("compare-2")).success).toBe(true);
  });
});

describe("blank text", () => {
  test("a comment of whitespace is refused", () => {
    expect(EditComment.safeParse({ body: "   \n" }).success).toBe(false);
    expect(EditComment.safeParse({ body: "Looks right" }).success).toBe(true);
  });

  test("a guest name is trimmed, and spaces are no name", () => {
    expect(GuestName.parse({ name: "  Riley " })).toEqual({ name: "Riley" });
    expect(GuestName.safeParse({ name: "   " }).success).toBe(false);
  });
});
