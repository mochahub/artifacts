// Fail closed if smoke tags disappear; setup-only success is not a browser gate.
const args = ["--project=desktop", "--grep", "@smoke"];
const list = Bun.spawnSync(["bunx", "playwright", "test", "--list", "--reporter=json", ...args], {
  cwd: "apps/viewer",
});
if (!list.success) {
  console.error(list.stderr.toString());
  process.exit(1);
}
type Suite = { suites?: Suite[]; specs?: { file: string; tests: { projectName: string }[] }[] };
const files: string[] = [];
let claims = 0;
function visit(suite: Suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests) {
      if (test.projectName === "desktop") files.push(spec.file.split("/").pop() ?? "");
      if (test.projectName === "claim") claims++;
    }
  }
  for (const child of suite.suites ?? []) visit(child);
}
visit(JSON.parse(list.stdout.toString()));
const expected = ["editing.e2e.ts", "sign-in.e2e.ts", "viewer.e2e.ts"];
if (claims !== 3 || JSON.stringify(files.sort()) !== JSON.stringify(expected)) {
  throw new Error(
    `Expected exactly one desktop smoke in each of ${expected}; selected ${files}, claim prerequisites ${claims}`,
  );
}
const result = Bun.spawnSync(["bun", "scripts/e2e.ts", ...args], { stdout: "inherit", stderr: "inherit" });
process.exit(result.exitCode ?? 1);
