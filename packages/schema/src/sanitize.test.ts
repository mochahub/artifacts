import { describe, expect, test } from "bun:test";
import { sanitizeArticle } from "./sanitize.ts";

describe("article images", () => {
  test.each([
    ["a protocol-relative address", '<img src="//evil.test/pixel.png">'],
    ["a path on the viewer's own origin", '<img src="/api/me">'],
    ["a relative path", '<img src="pictures/a.png">'],
    ["an absolute address", '<img src="https://evil.test/pixel.png">'],
    ["a data URL", '<img src="data:image/svg+xml,<svg/>">'],
    ["a blob path that climbs out", '<img src="artifacts:blob/../../me">'],
    ["a blob path with a query", '<img src="artifacts:blob/abc?x=/api/me">'],
  ])("drops %s", (_, html) => {
    expect(sanitizeArticle(html)).toBe("<img>");
  });

  test("keeps a bundle image", () => {
    const hash = "a".repeat(64);
    expect(sanitizeArticle(`<img src="artifacts:blob/${hash}" alt="x">`)).toBe(
      `<img src="artifacts:blob/${hash}" alt="x">`,
    );
  });
});

describe("svg paint", () => {
  const fill = (value: string) => sanitizeArticle(`<svg><path d="M0 0" fill='${value}'/></svg>`);

  test.each([
    "url(//evil.test/x.svg#a)",
    "url(https://evil.test/x.svg#a)",
    "url(x.svg#a)",
    "u\\72l(//evil.test/x.svg#a)",
    "red url(//evil.test/x.svg#a)",
  ])("drops the fill %p", (value) => {
    expect(fill(value)).toBe('<svg><path d="M0 0"></path></svg>');
  });

  test.each([
    "none",
    "#fff",
    "#5e6470",
    "currentColor",
    "rgb(236, 236, 255)",
    "rgba(0, 0, 0, 0.5)",
    "hsl(210 20% 40% / 50%)",
    "url(#grad)",
    'url("#grad")',
  ])("keeps the fill %p", (value) => {
    expect(fill(value)).toContain("fill=");
  });

  test("keeps internal marker references, not external ones", () => {
    const clean = sanitizeArticle(
      '<svg><path d="M0 0" marker-end="url(#arrow)"/><path d="M0 0" marker-end="url(https://evil.test/#a)"/></svg>',
    );
    expect(clean).toContain('marker-end="url(#arrow)"');
    expect(clean).not.toContain("evil.test");
  });

  test("applies to stroke too", () => {
    expect(sanitizeArticle('<svg><path stroke="url(//evil.test/x.svg#a)"/></svg>')).not.toContain("stroke");
  });

  test("a quoted internal reference survives a second pass", () => {
    const once = fill('url("#grad")');
    expect(sanitizeArticle(once)).toBe(once);
  });
});

describe("hostile markup", () => {
  test("drops script and style, and keeps the block keys", () => {
    const clean = sanitizeArticle(
      '<p data-block="a">Hi<script>alert(1)</script></p><style>body{display:none}</style>',
    );
    expect(clean).toBe('<p data-block="a">Hi</p>');
  });

  test("is stable: sanitizing twice changes nothing", () => {
    const once = sanitizeArticle(
      '<h2 id="a" data-block="a">T</h2><table><tr><td align="left">x</td></tr></table>',
    );
    expect(sanitizeArticle(once)).toBe(once);
  });

  test.each([
    '<a href="java&#9;script:alert(1)">x</a>',
    '<a href=" javascript:alert(1)">x</a>',
    '<a href="&#106;avascript&colon;alert(1)">x</a>',
    '<a href="data:text/html,x">x</a>',
    '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
  ])("drops the link target in %p", (html) => {
    expect(sanitizeArticle(html)).not.toMatch(/href/i);
  });

  test("drops use, foreignObject, set, base, meta, form, iframe and srcdoc", () => {
    const clean = sanitizeArticle(
      '<svg><use href="#a"/><set attributeName="href" to="javascript:1"/><foreignObject><div>x</div></foreignObject></svg>' +
        '<base href="//evil.test/"><meta http-equiv="refresh" content="0;url=//evil.test">' +
        '<form action="//evil.test"><input name="x"></form><iframe srcdoc="<script>1</script>"></iframe>',
    );
    for (const bad of [
      "<use",
      "<set",
      "foreignObject",
      "<base",
      "<meta",
      "<form",
      "<iframe",
      "srcdoc",
      "action",
    ]) {
      expect(clean).not.toContain(bad);
    }
  });

  test("drops style, event attributes and target", () => {
    const clean = sanitizeArticle(
      '<p style="background:url(//evil.test)" onclick="x()"><a href="https://ok.test" target="_blank">x</a></p>',
    );
    expect(clean).toBe('<p><a href="https://ok.test">x</a></p>');
  });

  test("drops name, so nothing can clobber a document property", () => {
    expect(sanitizeArticle('<a name="cookie" href="mailto:a@b.test">x</a>')).not.toContain("name=");
  });

  test("escapes text that looks like markup inside title", () => {
    const clean = sanitizeArticle("<title>&lt;/title&gt;&lt;img src=x onerror=alert(1)&gt;</title>");
    expect(clean).not.toContain("</title><img");
    expect(clean).not.toContain("<img");
  });
});
