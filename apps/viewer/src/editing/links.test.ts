import { expect, test } from "bun:test";
import { safeHref } from "./plugins.ts";

// Exercise the editor's own boundary (stricter than stored document links), without
// opening the Link sheet once per input/device. E2E keeps one refusal and one save.
test.each([
  "https://example.com/path?q=x#part",
  "http://localhost:8080/x",
  "HTTPS://example.com",
  "mailto:person@example.com",
  "/wiki/page",
  "./page",
  "../page",
  "#section",
  "  https://example.com  ",
])("the editor accepts %j", (href) => {
  expect(safeHref(href)).toBe(true);
});

test.each([
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  " data:text/html,<script>alert(1)</script>",
  "file:///etc/passwd",
  "//evil.example/path",
  "ftp://example.com",
  "https://",
  "example.com",
  "",
])("the editor refuses %j", (href) => {
  expect(safeHref(href)).toBe(false);
});
