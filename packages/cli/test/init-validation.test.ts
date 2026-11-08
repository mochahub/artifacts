import { expect, test } from "bun:test";
import { initCommand } from "../src/commands/write.ts";
import { type Output, UsageError } from "../src/output.ts";

// Rejected flags must fail at the command boundary, before any filesystem writes.
const out: Output = {
  json: true,
  say() {
    throw new Error("unexpected output");
  },
  warn() {
    throw new Error("unexpected warning");
  },
  result() {
    throw new Error("unexpected success");
  },
};

test.each([
  [{ template: "prd", kind: "article" }, "Use --template or --kind"],
  [{ template: "constructor" }, "weekly-status"],
  [{ template: "missing" }, "weekly-status"],
  [{ kind: "constructor" }, "--kind is canvas, article or prototype"],
  [{ slug: "../outside", "in-repo": true }, "--slug uses"],
])("init rejects invalid flags %j before writing", (flags, message) => {
  const run = () => initCommand({ args: {}, rest: [], flags, usage: () => new UsageError("usage") }, out);
  expect(run).toThrow(UsageError);
  expect(run).toThrow(message);
});
