// Fails if an API route was registered but no test ever reached it ("every route gets a test").
// The test helper writes the server's route list (`route GET /api/...`) and every request's route here.

const file = process.argv[2] as string;
const lines = (await Bun.file(file).text()).split("\n");
const routes = [...new Set(lines.filter((line) => line.startsWith("route ")).map((line) => line.slice(6)))];
if (routes.length === 0) {
  console.error("No test server wrote its route list, so coverage can't be checked.");
  process.exit(1);
}
const hits = new Set(lines);
const missed = routes.filter((route) => !hits.has(route));
if (missed.length > 0) {
  console.error(`No test reached these routes:\n${missed.join("\n")}`);
  process.exit(1);
}
console.log(`Every one of the ${routes.length} API routes was reached by a test.`);
process.exit(0);
